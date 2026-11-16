// The pipeline agent: works each rep's deals on their behalf.
//
// Several times a day it reviews every open deal and keeps a short to-do list
// ("call this new lead", "this quote has gone quiet: here's a nudge", "how did
// the site visit go?"). When a client replies it reads the reply and moves the
// deal (assist mode, clear-cut cases only) or asks the rep to (suggest mode).
//
// What it never does: send a text. Chasing creates a DRAFT that goes through
// the normal review screen, so the six send rules in service.ts still apply.
// Won and Lost are always the rep's call. Every agent change is logged in
// kw_activity with an undo.
import {
  KW_OPEN_STAGES, KW_STAGES, kwStageLabel, type KwAgentState, type KwAgentTask, type KwStage, type KwTaskKind,
} from '@tsba/shared';
import { query } from '../db.js';
import { readReply } from './ai.js';
import { getUndo, listActivity, logActivity, markUndone, type UndoStage } from './activity.js';
import * as repo from './repo.js';
import type { StoredClient, StoredProfile } from './repo.js';
import { settings } from './settings.js';
import { addDays, localDate, localParts, skipSunday } from './time.js';
import { KwError, composeFor, logScoreAs } from './service.js';
import { handBack, handbackReason } from './conversation.js';

const stageInfo = (s: KwStage) => KW_STAGES.find((x) => x.id === s)!;
const firstName = (n: string) => n.trim().split(/[\s&]+/)[0] || n;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isOpen = (s: KwStage) => KW_OPEN_STAGES.includes(s);

// ─── Tasks storage ──────────────────────────────────────────────────────────
interface TaskRow {
  id: string; client_id: string; client_name: string; kind: KwTaskKind; title: string; reason: string; priority: number;
  payload: KwAgentTask['payload']; status: KwAgentTask['status']; created_at: Date; resolved_at: Date | null;
}

const toTask = (r: TaskRow): KwAgentTask => ({
  id: r.id,
  clientId: r.client_id,
  clientName: r.client_name,
  kind: r.kind,
  title: r.title,
  reason: r.reason,
  priority: Math.min(3, Math.max(1, r.priority)) as 1 | 2 | 3,
  payload: r.payload ?? {},
  status: r.status,
  createdAt: r.created_at.toISOString(),
  resolvedAt: r.resolved_at?.toISOString() ?? null,
});

export async function openTasks(userId: string, clientId?: string): Promise<KwAgentTask[]> {
  const res = await query<TaskRow>(
    `SELECT t.*, c.name AS client_name FROM kw_agent_tasks t JOIN kw_clients c ON c.id = t.client_id
      WHERE t.user_id = $1 AND t.status = 'open' ${clientId ? 'AND t.client_id = $2' : ''}
      ORDER BY t.priority, t.created_at`,
    clientId ? [userId, clientId] : [userId],
  );
  return res.rows.map(toTask);
}

async function getTask(userId: string, id: string): Promise<KwAgentTask | null> {
  const res = await query<TaskRow>(
    `SELECT t.*, c.name AS client_name FROM kw_agent_tasks t JOIN kw_clients c ON c.id = t.client_id WHERE t.id = $1 AND t.user_id = $2`,
    [id, userId],
  );
  return res.rows[0] ? toTask(res.rows[0]) : null;
}

interface Candidate {
  kind: KwTaskKind;
  title: string;
  reason: string;
  priority: 1 | 2 | 3;
  payload?: KwAgentTask['payload'];
}

/** Create or refresh an open task, unless the rep dismissed the same one recently. */
async function raise(userId: string, clientId: string, t: Candidate): Promise<void> {
  const snoozed = await query(
    `SELECT 1 FROM kw_agent_tasks WHERE client_id = $1 AND kind = $2 AND status = 'dismissed' AND snooze_until > now() LIMIT 1`,
    [clientId, t.kind],
  );
  if (snoozed.rowCount) return;
  await query(
    `INSERT INTO kw_agent_tasks (id, user_id, client_id, kind, title, reason, priority, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (client_id, kind) WHERE status = 'open'
     DO UPDATE SET title = EXCLUDED.title, reason = EXCLUDED.reason, priority = EXCLUDED.priority, payload = EXCLUDED.payload`,
    [repo.newId(), userId, clientId, t.kind, t.title, t.reason, t.priority, JSON.stringify(t.payload ?? {})],
  );
}

async function resolve(id: string, status: 'done' | 'dismissed', snoozeDays = 0): Promise<void> {
  await query(
    `UPDATE kw_agent_tasks SET status = $2, resolved_at = now(),
            snooze_until = CASE WHEN $3::int > 0 THEN now() + make_interval(days => $3::int) ELSE NULL END
      WHERE id = $1 AND status = 'open'`,
    [id, status, snoozeDays],
  );
}

/** Close a client's open tasks that a change made irrelevant (e.g. the deal moved). */
export async function closeFor(clientId: string, kinds?: KwTaskKind[]): Promise<void> {
  await query(
    `UPDATE kw_agent_tasks SET status = 'done', resolved_at = now()
      WHERE client_id = $1 AND status = 'open' ${kinds ? 'AND kind = ANY($2)' : ''}`,
    kinds ? [clientId, kinds] : [clientId],
  );
}

// ─── Moving a deal ──────────────────────────────────────────────────────────
export async function moveStage(
  p: StoredProfile,
  c: StoredClient,
  to: KwStage,
  actor: 'agent' | 'rep',
  why: string,
  extra: { lostReason?: string } = {},
): Promise<StoredClient> {
  const from = c.dealStage;
  const patch: repo.ClientPatch = { dealStage: to };
  // A closed deal is never auto-answered.
  if (!isOpen(to) && c.convo === 'agent') { patch.convo = 'idle'; patch.convoReason = ''; }
  if (to === 'lost') {
    patch.lostReason = extra.lostReason ?? '';
    // A lost deal gets no more business follow-ups.
    patch.cadenceDays = null;
    patch.nextDue = null;
  }
  await repo.updateClient(p.userId, c.id, patch);
  if (to === 'lost') {
    await query(
      `UPDATE kw_messages SET status = 'skipped', error = 'Deal closed as lost', updated_at = now()
        WHERE client_id = $1 AND direction = 'out' AND status = 'draft' AND kind <> 'reply'`,
      [c.id],
    );
  }
  // Stage-bound tasks no longer apply once the deal moves.
  await closeFor(c.id, ['move_stage', 'chase', 'call', 'log_outcome', 'close_lost', ...(isOpen(to) ? [] : (['set_rhythm', 'add_value'] as KwTaskKind[]))]);
  const undo: UndoStage | undefined = actor === 'agent'
    ? { type: 'stage', clientId: c.id, toStage: to, fromStage: from, fromChangedAt: c.stageChangedAt, cadenceDays: c.cadenceDays, nextDue: c.nextDue }
    : undefined;
  const verb = from === to ? `Kept ${c.name} at ${kwStageLabel(to)}` : `Moved ${c.name}: ${kwStageLabel(from)} → ${kwStageLabel(to)}`;
  await logActivity(p.userId, c.id, actor, 'stage', why ? `${verb}. ${why}` : verb, undo);
  return (await repo.getClient(p.userId, c.id, p.timezone))!;
}

// ─── Reading replies ────────────────────────────────────────────────────────
/** Called after a client reply is stored. Never throws. */
export async function onReply(p: StoredProfile, c: StoredClient, body: string): Promise<void> {
  try {
    await logActivity(p.userId, c.id, 'agent', 'reply', `Read ${c.name}'s reply: “${body.slice(0, 140)}”`);
    if (!isOpen(c.dealStage)) return;
    await closeFor(c.id, ['chase', 'close_lost']); // they're talking again
    const thread = await repo.listThread(p.userId, c.id);
    const recent = thread.slice(-5, -1).map((m) => `${m.direction === 'out' ? p.displayName : firstName(c.name)}: ${m.body}`);
    const sig = await readReply(body, { clientName: c.name, stage: c.dealStage, recent });
    if (!sig.toStage) return;
    const why = sig.quote ? `They said “${sig.quote}”.` : sig.summary;
    const auto = settings().agentMode === 'assist' && sig.confidence === 'clear' && sig.toStage !== 'won' && sig.toStage !== 'lost';
    if (auto) {
      await moveStage(p, c, sig.toStage, 'agent', why);
      return;
    }
    await raise(p.userId, c.id, {
      kind: sig.toStage === 'lost' ? 'close_lost' : 'move_stage',
      title: sig.toStage === 'lost' ? `Close ${firstName(c.name)} as lost?` : `Move ${firstName(c.name)} to ${kwStageLabel(sig.toStage)}?`,
      reason: `${sig.summary} ${why}`.trim(),
      priority: sig.toStage === 'won' || sig.toStage === 'meeting' ? 1 : 2,
      payload: { toStage: sig.toStage, quote: sig.quote, intent: sig.intent },
    });
  } catch (err) {
    console.warn('[keepwarm] reading reply failed:', (err as Error).message);
  }
}

// ─── The review pass ────────────────────────────────────────────────────────
const RHYTHM_FOR: Partial<Record<KwStage, number>> = { contacted: 14, meeting: 7, quoted: 7, negotiating: 7 };

function daysSince(iso: string | null, today: string, tz: string): number | null {
  if (!iso) return null;
  const d = localDate(new Date(iso), tz);
  return Math.round((Date.parse(today) - Date.parse(d)) / 86_400_000);
}

/** The rule book: what a good sales manager would nudge the rep about, per deal. */
export function candidatesFor(c: StoredClient, today: string, tz: string, hasDraft: boolean): Candidate[] {
  if (c.optedOut || !isOpen(c.dealStage)) return [];
  const out: Candidate[] = [];
  const f = firstName(c.name);
  const info = stageInfo(c.dealStage);
  const sinceContact = daysSince(c.lastContactAt, today, tz);
  const sinceReply = daysSince(c.lastReplyAt, today, tz);
  // "Last touch" = most recent of: we texted, they replied, deal moved.
  const quiet = Math.min(sinceContact ?? Infinity, sinceReply ?? Infinity, c.daysInStage);
  const repliedSinceContact = !!c.lastReplyAt && (!c.lastContactAt || c.lastReplyAt > c.lastContactAt);

  if (c.dealStage === 'lead') {
    if (c.lastContactAt || c.lastReplyAt) {
      out.push({ kind: 'move_stage', title: `Move ${f} to Contacted?`, reason: 'You’ve already been in touch, so they’re no longer a new lead.', priority: 3, payload: { toStage: 'contacted' } });
    } else if (c.daysInStage >= info.staleDays) {
      out.push({
        kind: 'call', title: `Call ${f}`, priority: 1,
        reason: `New lead added ${plural(c.daysInStage, 'day')} ago and nobody has spoken to them yet. Leads go cold fast.`,
      });
    }
  }

  if (c.dealStage === 'meeting' && c.daysInStage >= info.staleDays) {
    out.push({
      kind: 'log_outcome', title: `How did it go with ${f}?`, priority: 1,
      reason: `The site visit stage started ${plural(c.daysInStage, 'day')} ago. Log the outcome so the right follow-up starts.`,
    });
  }

  const goneQuiet = ['contacted', 'quoted', 'negotiating'].includes(c.dealStage) && quiet >= info.staleDays && !c.paused && !hasDraft;
  const rhythmSoon = c.cadenceDays && c.nextDue && c.nextDue <= addDays(today, 2);
  if (quiet >= 60 && !repliedSinceContact && c.dealStage !== 'lead') {
    out.push({
      kind: 'close_lost', title: `Close ${f} as lost?`, priority: 2, payload: { toStage: 'lost' },
      reason: `No reply in ${quiet} days. Closing it keeps your forecast honest; you can reopen it any time.`,
    });
  } else if (goneQuiet && !rhythmSoon) {
    const what = c.dealStage === 'quoted' ? 'Quote sent' : c.dealStage === 'negotiating' ? 'They were deciding' : 'Last contact';
    out.push({
      kind: 'chase', title: `Nudge ${f}`, priority: c.dealStage === 'contacted' ? 2 : 1,
      reason: `${what} ${plural(quiet, 'day')} ago with nothing since. I can draft a short, specific follow-up for you to check.`,
    });
  }

  if (c.dealStage !== 'lead' && !c.cadenceDays && c.phone) {
    const days = RHYTHM_FOR[c.dealStage] ?? 14;
    out.push({
      kind: 'set_rhythm', title: `Keep ${f} warm`, priority: 3, payload: { cadenceDays: days },
      reason: `No follow-up rhythm, so ${f} won’t hear from you unless you remember. ${days === 7 ? 'Weekly' : 'Fortnightly'} suits ${kwStageLabel(c.dealStage).toLowerCase()}.`,
    });
  }

  if ((c.dealStage === 'quoted' || c.dealStage === 'negotiating') && c.dealValue == null) {
    out.push({ kind: 'add_value', title: `Add ${f}’s quote value`, priority: 3, reason: 'Without it the forecast can’t count this deal.' });
  }
  return out;
}

const RULE_KINDS: KwTaskKind[] = ['call', 'log_outcome', 'chase', 'set_rhythm', 'add_value', 'close_lost', 'handback'];
const lastRun = new Map<string, number>();
const running = new Set<string>();

/** Review every deal for one rep: raise what's needed, retire what resolved itself. */
export async function review(p: StoredProfile): Promise<void> {
  if (running.has(p.userId)) return;
  running.add(p.userId);
  try {
    const today = localDate(new Date(), p.timezone);
    const [clients, open, existing] = await Promise.all([repo.listClients(p.userId, p.timezone), repo.listOpen(p.userId), openTasks(p.userId)]);
    const drafting = new Set(open.map((m) => m.clientId));
    const wanted = new Set<string>();
    const assist = settings().agentMode === 'assist';
    for (const c of clients) {
      for (const t of candidatesFor(c, today, p.timezone, drafting.has(c.id))) {
        // Clear, safe bookkeeping the agent can just do in assist mode.
        if (assist && t.kind === 'move_stage' && t.payload?.toStage === 'contacted') {
          await moveStage(p, c, 'contacted', 'agent', t.reason);
          continue;
        }
        wanted.add(`${c.id}:${t.kind}`);
        await raise(p.userId, c.id, t);
      }
      // A conversation the rep took over that looks finished: offer to hand it back.
      const why = await handbackReason(p, c).catch(() => null);
      if (why) {
        wanted.add(`${c.id}:handback`);
        await raise(p.userId, c.id, { kind: 'handback', title: `Hand ${firstName(c.name)} back to the agent?`, reason: why, priority: 3 });
      }
    }
    // A rule task whose condition no longer holds (rep acted elsewhere) resolves itself.
    for (const t of existing) {
      if (RULE_KINDS.includes(t.kind) && !wanted.has(`${t.clientId}:${t.kind}`) && !(t.kind === 'close_lost' && t.payload.intent)) {
        await resolve(t.id, 'done');
      }
    }
    lastRun.set(p.userId, Date.now());
  } finally {
    running.delete(p.userId);
  }
}

// ─── What the rep sees ──────────────────────────────────────────────────────
function brief(tasks: KwAgentTask[], clients: StoredClient[]): string {
  const openDeals = clients.filter((c) => isOpen(c.dealStage) && !c.optedOut);
  const value = openDeals.reduce((s, c) => s + (c.dealValue ?? 0), 0);
  const weighted = openDeals.reduce((s, c) => s + (c.dealValue ?? 0) * stageInfo(c.dealStage).prob, 0);
  const money = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`);
  const count = (k: KwTaskKind) => tasks.filter((t) => t.kind === k).length;
  const bits = [
    count('call') && `${plural(count('call'), 'lead')} to call`,
    count('chase') && `${plural(count('chase'), 'deal')} gone quiet`,
    count('log_outcome') && `${plural(count('log_outcome'), 'visit')} to log`,
    count('move_stage') + count('close_lost') && `${plural(count('move_stage') + count('close_lost'), 'stage change')} to confirm`,
  ].filter(Boolean);
  const head = bits.length ? `${bits.join(', ')}.` : 'Nothing needs you right now. Every open deal has a next step.';
  const pipe = openDeals.length ? ` ${plural(openDeals.length, 'open deal')}${value ? `, ${money(value)} quoted, ${money(weighted)} weighted` : ''}.` : '';
  return head + pipe;
}

export async function state(p: StoredProfile): Promise<KwAgentState> {
  // Fresh enough? The background loop runs every 30 minutes; a visit refreshes if older than 10.
  if (Date.now() - (lastRun.get(p.userId) ?? 0) > 10 * 60_000) await review(p).catch((err) => console.warn('[keepwarm] agent review:', err));
  const [tasks, activity, clients] = await Promise.all([openTasks(p.userId), listActivity(p.userId, { limit: 40 }), repo.listClients(p.userId, p.timezone)]);
  const at = lastRun.get(p.userId);
  return {
    mode: settings().agentMode,
    lastRunAt: at ? new Date(at).toISOString() : null,
    running: running.has(p.userId),
    tasks,
    activity,
    brief: brief(tasks, clients),
  };
}

export async function runNow(p: StoredProfile): Promise<KwAgentState> {
  lastRun.delete(p.userId);
  return state(p);
}

// ─── Acting on a task ───────────────────────────────────────────────────────
export interface AcceptBody {
  toStage?: string;
  value?: number;
  outcome?: 'spoke' | 'no_answer';
  attended?: boolean;
  lostReason?: string;
  cadenceDays?: number;
  /** Handback: optional outcome to save with the conversation summary. */
  note?: string;
}

/** The rep says yes. Returns a draft id when the next step is reviewing a text. */
export async function accept(p: StoredProfile, id: string, b: AcceptBody): Promise<{ messageId?: string; note: string }> {
  const t = await getTask(p.userId, id);
  if (!t || t.status !== 'open') throw new KwError('That task has already been dealt with', 409);
  const c = await repo.getClient(p.userId, t.clientId, p.timezone);
  if (!c) throw new KwError('Client not found', 404);
  const f = firstName(c.name);
  let note = 'Done';
  let messageId: string | undefined;

  switch (t.kind) {
    case 'move_stage': {
      const to = (b.toStage ?? t.payload.toStage) as KwStage;
      if (!KW_STAGES.some((s) => s.id === to)) throw new KwError('Pick a stage');
      await moveStage(p, c, to, 'rep', t.payload.quote ? `They said “${t.payload.quote}”.` : '');
      note = `${f} is now ${kwStageLabel(to)}`;
      break;
    }
    case 'close_lost': {
      await moveStage(p, c, 'lost', 'rep', '', { lostReason: b.lostReason?.trim() || (t.payload.quote ? `“${t.payload.quote}”` : 'No reply') });
      note = `${f} closed as lost`;
      break;
    }
    case 'chase': {
      const instruction = c.dealStage === 'quoted'
        ? 'Follow up on the quote you sent. Refer to one real detail from the notes (what decides it, a worry, a promise). Offer one easy next step, like a quick call to go through it.'
        : c.dealStage === 'negotiating'
          ? 'They were weighing it up. Check in on whatever was holding them back (from the notes) and offer to answer questions. No pressure.'
          : 'It has been a while since you spoke. Check in genuinely, mention one real detail, and suggest a short catch-up.';
      const m = await composeFor(p, c.id, { type: 'business', instruction });
      messageId = m.id;
      note = 'Draft ready to check';
      await logActivity(p.userId, c.id, 'agent', 'drafted', `Drafted a follow-up for ${c.name} (${kwStageLabel(c.dealStage).toLowerCase()} gone quiet). Waiting for your review.`);
      break;
    }
    case 'call': {
      const spoke = b.outcome === 'spoke';
      await logScoreAs(p, 'calls', 1, 'agent');
      if (spoke) {
        await logScoreAs(p, 'convos', 1, 'agent');
        await moveStage(p, c, 'contacted', 'rep', 'Called and spoke.');
      } else {
        await logActivity(p.userId, c.id, 'rep', 'call', `Called ${c.name}, no answer.`);
        // Ask again in two days rather than nagging tomorrow.
        await resolve(t.id, 'dismissed', 2);
        return { note: 'Call logged. I’ll remind you again in 2 days.' };
      }
      note = 'Call logged on your scoreboard';
      break;
    }
    case 'log_outcome': {
      const to = b.toStage as KwStage;
      if (!['meeting', 'quoted', 'negotiating', 'won', 'lost'].includes(to)) throw new KwError('Pick what happened');
      if (b.attended !== false) await logScoreAs(p, 'attended', 1, 'agent');
      if (to === 'quoted') await logScoreAs(p, 'proposals', 1, 'agent');
      if (b.value != null && Number.isFinite(b.value) && b.value > 0) await repo.updateClient(p.userId, c.id, { dealValue: Math.round(b.value) });
      await moveStage(p, c, to, 'rep', b.attended === false ? 'Visit didn’t happen; rebooking.' : 'Site visit done.', { lostReason: b.lostReason });
      note = b.attended === false ? 'Noted. Still at site visit.' : `${f} is now ${kwStageLabel(to)}`;
      break;
    }
    case 'set_rhythm': {
      const days = Math.max(7, Math.min(90, Math.round(b.cadenceDays ?? t.payload.cadenceDays ?? 14)));
      const today = localDate(new Date(), p.timezone);
      await repo.updateClient(p.userId, c.id, { cadenceDays: days, mix: 'mix', nextType: 'business', nextDue: skipSunday(addDays(today, days)) });
      await logActivity(p.userId, c.id, 'rep', 'rhythm', `Set ${c.name} to a ${days}-day rhythm (business and friendly, alternating).`);
      note = `Rhythm set. First text drafts on ${skipSunday(addDays(today, days))}.`;
      break;
    }
    case 'handback': {
      note = (await handBack(p, c, b.note)).note;
      break;
    }
    case 'add_value': {
      const v = Number(b.value);
      if (!Number.isFinite(v) || v <= 0 || v > 10_000_000) throw new KwError('Enter the quote value in dollars');
      await repo.updateClient(p.userId, c.id, { dealValue: Math.round(v) });
      await logActivity(p.userId, c.id, 'rep', 'value', `Set ${c.name}’s deal value to $${Math.round(v).toLocaleString('en-AU')}.`);
      note = 'Value saved';
      break;
    }
  }
  await resolve(t.id, 'done');
  return { messageId, note };
}

/** Not now: the same nudge stays quiet for `days`. */
export async function dismiss(p: StoredProfile, id: string, days: number): Promise<void> {
  const t = await getTask(p.userId, id);
  if (!t || t.status !== 'open') throw new KwError('That task has already been dealt with', 409);
  await resolve(id, 'dismissed', Math.max(1, Math.min(60, Math.round(days || 7))));
}

/** Take back a change the agent made by itself. */
export async function undo(p: StoredProfile, activityId: string): Promise<void> {
  const r = await getUndo(p.userId, activityId);
  if (!r || !r.undo) throw new KwError('That can’t be undone', 409);
  if (r.undone) throw new KwError('Already undone', 409);
  const u = r.undo;
  const c = await repo.getClient(p.userId, u.clientId, p.timezone);
  if (!c) throw new KwError('Client not found', 404);
  if (c.dealStage !== u.toStage) throw new KwError(`${c.name} has moved since, so this can’t be undone`, 409);
  await repo.updateClient(p.userId, c.id, { dealStage: u.fromStage, ...(u.toStage === 'lost' ? { cadenceDays: u.cadenceDays ?? null, nextDue: u.nextDue ?? null, lostReason: '' } : {}) });
  await query('UPDATE kw_clients SET stage_changed_at = $2 WHERE id = $1', [c.id, u.fromChangedAt]);
  await markUndone(activityId);
  await logActivity(p.userId, c.id, 'rep', 'undo', `Undid the agent’s move: ${c.name} back to ${kwStageLabel(u.fromStage)}.`);
}

// ─── Background ─────────────────────────────────────────────────────────────
/** Review every rep's pipeline during their working day (6am–9pm local). */
export async function reviewAll(): Promise<void> {
  for (const p of await repo.listProfiles()) {
    const m = localParts(new Date(), p.timezone).minutes;
    if (m >= 6 * 60 && m < 21 * 60) await review(p).catch((err) => console.warn(`[keepwarm] agent review ${p.userId}:`, (err as Error).message));
  }
}
