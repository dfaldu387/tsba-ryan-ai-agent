// Business logic for the sales follow-up agent. The six product rules are
// enforced HERE, at send time, not just in the UI:
//   1. Only a rep-approved message is ever sent (no auto-send path exists).
//   2. The rep is the sender (their number, their sign-off).
//   3. Friendly check-ins never sell (prompt + guard in ai.ts).
//   4. A client reply pauses the rhythm and holds anything already approved.
//   5. STOP is forever (kw_optouts is checked right before every send).
//   6. Quiet hours: approved texts wait until 8am–8pm Mon–Sat, rep's time zone.
import {
  isKwStage, kwStageLabel,
  type KwClient, type KwLoggedMetric, type KwMessage, type KwMessageKind, type KwMix, type KwNote, type KwScore, type KwScoreboard,
  type KwStage, type KwTeamRow, type KwTextType, type KwToday,
} from '@tsba/shared';
import { logActivity } from './activity.js';
import { moveStage, onReply, reviewAll } from './agent.js';
import { agentSendBlock, route, takeOver } from './conversation.js';
import { settings } from './settings.js';
import { query } from '../db.js';
import { draftText, parseScore } from './ai.js';
import * as repo from './repo.js';
import type { StoredClient, StoredMessage, StoredProfile } from './repo.js';
import { isStopMessage, sendSms, smsMode } from './sms.js';
import { addDays, hm, isQuiet, localDate, localParts, nextAllowed, skipSunday, weekStart, zonedInstant } from './time.js';

export class KwError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export async function requireProfile(userId: string): Promise<StoredProfile> {
  const p = await repo.getProfile(userId);
  if (!p) throw new KwError('Finish setup first', 409);
  return p;
}

async function requireClient(p: StoredProfile, id: string): Promise<StoredClient> {
  const c = await repo.getClient(p.userId, id, p.timezone);
  if (!c) throw new KwError('Client not found', 404);
  return c;
}

const firstTypeFor = (mix: KwMix): KwTextType => (mix === 'friendly' ? 'friendly' : 'business');

// ─── Drafting ────────────────────────────────────────────────────────────────
async function writeDraft(
  p: StoredProfile,
  c: StoredClient,
  kind: KwMessageKind,
  type: KwTextType,
  opts: { instruction?: string; shorter?: boolean; avoid?: string } = {},
) {
  const thread = await repo.listThread(p.userId, c.id);
  return draftText({
    profile: p,
    client: { name: c.name, stage: c.stage, notes: c.notes },
    thread: thread.filter((m) => m.status === 'sent' || m.status === 'received').map((m) => ({ direction: m.direction, body: m.body, at: m.sentAt ?? m.createdAt })),
    type,
    kind,
    ...opts,
  });
}

export async function createDraft(p: StoredProfile, c: StoredClient, kind: KwMessageKind, type: KwTextType): Promise<StoredMessage> {
  const d = await writeDraft(p, c, kind, type);
  return repo.insertMessage({ userId: p.userId, clientId: c.id, direction: 'out', kind, type, status: 'draft', body: d.text, usedNotes: d.usedNotes });
}

// One generation pass per rep at a time; the Today screen polls while it runs.
const generating = new Map<string, { pending: number; run: Promise<void> }>();

function dueClients(clients: StoredClient[], today: string, openClientIds: Set<string>): StoredClient[] {
  return clients.filter((c) => c.cadenceDays && c.nextDue && c.nextDue <= today && !c.paused && !c.optedOut && c.phone && !openClientIds.has(c.id));
}

/** Make sure every client due today (or overdue) has a draft waiting. */
export function ensureDrafts(p: StoredProfile, limit = 25): number {
  const running = generating.get(p.userId);
  if (running) return running.pending;
  const state = { pending: 0, run: Promise.resolve() };
  state.run = (async () => {
    try {
      const today = localDate(new Date(), p.timezone);
      const [clients, open] = await Promise.all([repo.listClients(p.userId, p.timezone), repo.listOpen(p.userId)]);
      const due = dueClients(clients, today, new Set(open.map((m) => m.clientId))).slice(0, limit);
      state.pending = due.length;
      for (const c of due) {
        try {
          await createDraft(p, c, 'due', c.mix === 'mix' ? c.nextType : firstTypeFor(c.mix));
        } catch (err) {
          console.warn(`[keepwarm] draft for ${c.id} failed:`, (err as Error).message);
        }
        state.pending--;
      }
    } finally {
      generating.delete(p.userId);
    }
  })();
  generating.set(p.userId, state);
  return state.pending || 1;
}

// ─── Today ───────────────────────────────────────────────────────────────────
export async function today(p: StoredProfile): Promise<KwToday> {
  const pending = ensureDrafts(p);
  const date = localDate(new Date(), p.timezone);
  const [clients, open, score] = await Promise.all([repo.listClients(p.userId, p.timezone), repo.listOpen(p.userId), scoreFor(p, date, date)]);
  const byId = new Map(clients.map((c) => [c.id, c]));
  const items = open
    .map((m) => ({ message: publicMessage(m), client: publicClient(byId.get(m.clientId)!) }))
    .filter((x) => x.client && !x.client.optedOut);
  return {
    date,
    replies: items.filter((x) => x.message.status === 'draft' && x.message.kind === 'reply'),
    due: items.filter((x) => x.message.status === 'draft' && x.message.kind !== 'reply'),
    scheduled: items.filter((x) => x.message.status === 'scheduled'),
    noRhythm: clients.filter((c) => !c.cadenceDays && !c.optedOut).map(publicClient),
    agentHandling: settings().autoReply ? clients.filter((c) => c.convo === 'agent' && !c.optedOut).map(publicClient) : [],
    score: score.total,
    generating: generating.has(p.userId) ? pending : 0,
  };
}

// ─── Clients ─────────────────────────────────────────────────────────────────
export function publicClient(c: StoredClient): KwClient {
  const { userId: _u, phoneNorm: _p, repTypingAt: _t, ...rest } = c;
  return rest;
}
export function publicMessage(m: StoredMessage): KwMessage {
  const { userId: _u, aiBody: _a, ...rest } = m;
  return rest;
}

function dealValueOf(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new KwError('Deal value must be a dollar amount');
  return Math.round(n);
}

/** The free-text label from a voice note ("Quote sent") mapped to a pipeline stage. */
export function stageFromLabel(label: string): KwStage | null {
  const l = label.toLowerCase();
  if (/(signed|customer|installed|won|deposit)/.test(l)) return 'won';
  if (/(quote|proposal)/.test(l)) return 'quoted';
  if (/(deciding|thinking|considering|negotiat|comparing)/.test(l)) return 'negotiating';
  if (/(site visit|visit|meeting|met|inspection|assessment)/.test(l)) return 'meeting';
  if (/(called|spoke|contacted|chatted|enquir)/.test(l)) return 'contacted';
  return null;
}

export async function addClient(p: StoredProfile, body: { name?: string; phone?: string; email?: string; stage?: string; dealStage?: string; dealValue?: unknown }): Promise<KwClient> {
  const name = (body.name ?? '').trim();
  if (!name) throw new KwError('A name is needed');
  const dealStage = isKwStage(body.dealStage) ? body.dealStage : 'lead';
  const id = await repo.insertClient(p.userId, { name, phone: body.phone ?? '', email: body.email, stage: body.stage, dealStage, dealValue: dealValueOf(body.dealValue) ?? null });
  await logActivity(p.userId, id, 'rep', 'added', `Added ${name} to the pipeline as ${kwStageLabel(dealStage)}.`);
  return publicClient(await requireClient(p, id));
}

export async function clientDetail(p: StoredProfile, id: string): Promise<{ client: KwClient; thread: KwMessage[]; open: KwMessage[] }> {
  const c = await requireClient(p, id);
  const [thread, open] = await Promise.all([repo.listThread(p.userId, id), repo.listOpen(p.userId)]);
  return { client: publicClient(c), thread: thread.map(publicMessage), open: open.filter((m) => m.clientId === id).map(publicMessage) };
}

export interface ClientUpdate {
  name?: string; phone?: string; email?: string; stage?: string; notes?: { id?: string; cat: KwNote['cat']; text: string }[];
  transcript?: string; cadenceDays?: number | null; mix?: KwMix; sendTime?: string | null; firstDue?: string | null;
  firstText?: boolean; resume?: boolean;
  dealStage?: string; dealValue?: unknown; expectedClose?: string | null; lostReason?: string;
}

export async function updateClient(p: StoredProfile, id: string, u: ClientUpdate): Promise<KwClient> {
  const before = await requireClient(p, id);
  const patch: repo.ClientPatch = { name: u.name, phone: u.phone, email: u.email, stage: u.stage, transcript: u.transcript };
  const value = dealValueOf(u.dealValue);
  if (value !== undefined) patch.dealValue = value;
  if (u.expectedClose !== undefined) patch.expectedClose = u.expectedClose && /^\d{4}-\d{2}-\d{2}$/.test(u.expectedClose) ? u.expectedClose : null;
  if (u.lostReason !== undefined) patch.lostReason = u.lostReason;
  if (u.dealStage !== undefined && !isKwStage(u.dealStage)) throw new KwError('Unknown pipeline stage');
  if (u.notes) patch.notes = u.notes.filter((n) => n.text?.trim()).map((n) => ({ id: n.id || repo.newId().slice(0, 8), cat: n.cat, text: n.text.trim() }));
  if (u.cadenceDays !== undefined) {
    const cad = u.cadenceDays && u.cadenceDays > 0 ? Math.min(365, Math.round(u.cadenceDays)) : null;
    patch.cadenceDays = cad;
    const today = localDate(new Date(), p.timezone);
    patch.nextDue = cad ? skipSunday(u.firstDue && u.firstDue >= today ? u.firstDue : addDays(today, cad)) : null;
  }
  if (u.mix) {
    patch.mix = u.mix;
    patch.nextType = firstTypeFor(u.mix);
  }
  if (u.sendTime !== undefined) patch.sendTime = u.sendTime && /^\d{1,2}:\d{2}$/.test(u.sendTime) ? u.sendTime : null;
  if (u.resume) patch.paused = false;
  await repo.updateClient(p.userId, id, patch);
  if (value !== undefined && value !== before.dealValue) {
    await logActivity(p.userId, id, 'rep', 'value', value == null ? `Cleared ${before.name}'s deal value.` : `Set ${before.name}'s deal value to $${value.toLocaleString('en-AU')}.`);
  }
  if (isKwStage(u.dealStage) && u.dealStage !== before.dealStage) {
    await moveStage(p, before, u.dealStage, 'rep', '', { lostReason: u.lostReason });
  } else if (u.stage && before.dealStage === 'lead') {
    // A voice note said where things are at ("Quote sent"): the agent files the deal there.
    const guess = stageFromLabel(u.stage);
    if (guess && guess !== 'won') await moveStage(p, before, guess, 'agent', `Your note says "${u.stage}".`);
  }
  const updated = await requireClient(p, id);
  // "First text after today's visit, while it's fresh."
  if (u.firstText && updated.phone && !updated.optedOut) {
    const existing = await repo.openDraftFor(id);
    if (!existing) await createDraft(p, updated, 'new', firstTypeFor(updated.mix)).catch((err) => console.warn('[keepwarm] first text failed:', err));
  }
  return publicClient(updated);
}

export async function removeClient(p: StoredProfile, id: string): Promise<void> {
  await requireClient(p, id);
  await repo.deleteClient(p.userId, id);
}

/** A one-off text, or a fresh draft if the rep opens a client and taps "Text". */
export async function composeFor(p: StoredProfile, clientId: string, body: { type?: KwTextType; instruction?: string }): Promise<KwMessage> {
  const c = await requireClient(p, clientId);
  if (c.optedOut) throw new KwError(`${c.name} asked not to be texted. Stop means stop.`);
  if (c.convo === 'agent') await takeOver(p, c, 'You started a text');
  const existing = await repo.openDraftFor(clientId);
  if (existing) return publicMessage(existing);
  const type = body.type ?? firstTypeFor(c.mix);
  const kind: KwMessageKind = c.paused ? 'reply' : 'adhoc';
  if (!body.instruction && kind === 'adhoc') {
    return publicMessage(await repo.insertMessage({ userId: p.userId, clientId, direction: 'out', kind, type, status: 'draft', body: '' }));
  }
  const d = await writeDraft(p, c, kind, type, { instruction: body.instruction });
  return publicMessage(await repo.insertMessage({ userId: p.userId, clientId, direction: 'out', kind, type, status: 'draft', body: d.text, usedNotes: d.usedNotes }));
}

// ─── Review actions ──────────────────────────────────────────────────────────
async function requireDraft(p: StoredProfile, id: string): Promise<StoredMessage> {
  const m = await repo.getMessage(p.userId, id);
  if (!m || m.direction !== 'out') throw new KwError('Draft not found', 404);
  if (m.status !== 'draft') throw new KwError('This text has already been dealt with', 409);
  return m;
}

export async function rewrite(p: StoredProfile, id: string, body: { type?: KwTextType; instruction?: string; shorter?: boolean; another?: boolean; current?: string }): Promise<KwMessage> {
  const m = await requireDraft(p, id);
  const c = await requireClient(p, m.clientId);
  const type = body.type ?? m.type;
  const d = await writeDraft(p, c, m.kind, type, {
    instruction: body.instruction?.trim() || undefined,
    shorter: body.shorter,
    avoid: body.another ? body.current || m.body : undefined,
  });
  return publicMessage(await repo.updateMessage(id, { type, body: d.text, aiBody: d.text, usedNotes: d.usedNotes }));
}

export async function approve(p: StoredProfile, id: string, body: { text?: string; type?: KwTextType }): Promise<{ message: KwMessage; client: KwClient; note: string }> {
  const m = await requireDraft(p, id);
  const c = await requireClient(p, m.clientId);
  const text = (body.text ?? m.body).trim();
  if (!text) throw new KwError('The text is empty');
  if (text.length > 480) throw new KwError('That is more than three texts long. Trim it down.');
  if (!c.phone) throw new KwError(`${c.name} has no mobile number`);
  if (c.optedOut || (await repo.isOptedOut(c.phoneNorm))) throw new KwError(`${c.name} asked not to be texted. Stop means stop.`);
  if (c.paused && m.kind !== 'reply') throw new KwError(`${c.name} replied. Answer their message first.`);

  // Due texts wait for the client's chosen send time; everything waits out quiet hours.
  const now = new Date();
  let at = now;
  if (m.kind === 'due') {
    const local = localParts(now, p.timezone);
    const wanted = zonedInstant(local.date, hm(c.sendTime ?? p.sendTime, p.sendTime), p.timezone);
    if (wanted > now) at = wanted;
  }
  at = nextAllowed(at, p.timezone);

  if (settings().autoReply && (m.kind === 'reply' || m.kind === 'adhoc')) {
    if (c.convo === 'agent') await takeOver(p, c, 'You sent your own text');
    else if (c.convo === 'idle') await repo.updateClient(p.userId, c.id, { convo: 'rep', convoReason: 'You answered this conversation yourself' });
  }
  let msg = await repo.updateMessage(id, { body: text, type: body.type ?? m.type, approvedAt: now, scheduledFor: at, status: 'scheduled' });
  if (at <= now) msg = await dispatch(msg);
  const client = await requireClient(p, m.clientId);
  return { message: publicMessage(msg), client: publicClient(client), note: noteFor(msg, p) };
}

function noteFor(m: StoredMessage, p: StoredProfile): string {
  if (m.status === 'sent') return 'Sent';
  if (m.status === 'failed') return `Not sent: ${m.error ?? 'unknown error'}`;
  if (m.status === 'scheduled' && m.scheduledFor) {
    const when = new Date(m.scheduledFor).toLocaleString('en-AU', { timeZone: p.timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return isQuiet(new Date(), p.timezone) ? `Quiet hours. It goes out ${when}.` : `Approved. It goes out ${when}.`;
  }
  return m.status;
}

export async function snooze(p: StoredProfile, id: string, days: number): Promise<void> {
  const m = await requireDraft(p, id);
  const c = await requireClient(p, m.clientId);
  await repo.updateMessage(id, { status: 'skipped', error: `Snoozed ${days} day(s)` });
  if (m.kind === 'due') {
    await repo.updateClient(p.userId, c.id, { nextDue: skipSunday(addDays(localDate(new Date(), p.timezone), Math.max(1, Math.min(30, days)))) });
  }
}

export async function skip(p: StoredProfile, id: string): Promise<void> {
  const m = await requireDraft(p, id);
  const c = await requireClient(p, m.clientId);
  await repo.updateMessage(id, { status: 'skipped', error: 'Skipped by rep' });
  if (m.kind === 'due' && c.cadenceDays) {
    await repo.updateClient(p.userId, c.id, { nextDue: skipSunday(addDays(localDate(new Date(), p.timezone), c.cadenceDays)) });
  }
}

/** Cancel an approved text that is still waiting for its send time. */
export async function unschedule(p: StoredProfile, id: string): Promise<KwMessage> {
  const m = await repo.getMessage(p.userId, id);
  if (!m || m.status !== 'scheduled') throw new KwError('Nothing waiting to send', 409);
  return publicMessage(await repo.updateMessage(id, { status: 'draft', approvedAt: null, scheduledFor: null }));
}

// ─── Sending (the only path to a client's phone) ────────────────────────────
async function dispatch(m: StoredMessage): Promise<StoredMessage> {
  const p = await repo.getProfile(m.userId);
  const c = p ? await repo.getClient(m.userId, m.clientId, p.timezone) : null;
  if (!p || !c) return repo.updateMessage(m.id, { status: 'failed', error: 'Client or rep no longer exists' });
  if (!m.approvedAt) return repo.updateMessage(m.id, { status: 'failed', error: 'Not approved' });
  if (c.optedOut || (await repo.isOptedOut(c.phoneNorm))) return repo.updateMessage(m.id, { status: 'skipped', error: 'Client opted out' });
  if (m.kind !== 'reply' && c.lastReplyAt && new Date(c.lastReplyAt) > new Date(m.approvedAt)) {
    return repo.updateMessage(m.id, { status: 'held', error: 'Client replied after this was approved' });
  }
  if (m.sentBy === 'agent') {
    const block = agentSendBlock(m, c);
    if (block?.status === 'postpone') return repo.updateMessage(m.id, { scheduledFor: new Date(Date.now() + 60_000) });
    if (block) {
      await logActivity(p.userId, c.id, 'agent', 'auto_held', `Didn't send my reply to ${c.name}: ${block.why.toLowerCase()}.`);
      return repo.updateMessage(m.id, { status: 'held', error: block.why });
    }
  }
  if (isQuiet(new Date(), p.timezone)) return repo.updateMessage(m.id, { scheduledFor: nextAllowed(new Date(), p.timezone) });

  const out = await sendSms(c.phoneNorm, m.body, p.smsFrom || undefined);
  if (!out.ok) return repo.updateMessage(m.id, { status: 'failed', error: out.error ?? 'Send failed' });
  const sentAt = new Date();
  const sent = await repo.updateMessage(m.id, { status: 'sent', sentAt, providerId: out.providerId ?? null, error: null });

  // Advance the rhythm.
  const today = localDate(sentAt, p.timezone);
  const patch: repo.ClientPatch = { lastContactAt: sentAt };
  if (m.kind === 'due' && c.cadenceDays) {
    patch.nextDue = skipSunday(addDays(today, c.cadenceDays));
    if (c.mix === 'mix') patch.nextType = c.nextType === 'business' ? 'friendly' : 'business';
  }
  if (m.kind === 'reply') {
    // The rhythm restarts only once the rep has answered.
    patch.paused = false;
    if (c.cadenceDays) patch.nextDue = skipSunday(addDays(today, c.cadenceDays));
  }
  await repo.updateClient(p.userId, c.id, patch);
  const short = `"${m.body.slice(0, 120)}${m.body.length > 120 ? '…' : ''}"`;
  if (m.sentBy === 'agent') await logActivity(p.userId, c.id, 'agent', 'auto_sent', `Replied to ${c.name} for you: ${short}`);
  else await logActivity(p.userId, c.id, 'rep', 'sent', `Texted ${c.name}: ${short}`);
  return sent;
}

// ─── Inbound ────────────────────────────────────────────────────────────────
async function receiveFor(userId: string, clientId: string, body: string): Promise<void> {
  const p = await repo.getProfile(userId);
  if (!p) return;
  const c = await repo.getClient(userId, clientId, p.timezone);
  if (!c) return;
  const now = new Date();
  await repo.insertMessage({ userId, clientId, direction: 'in', kind: 'inbound', type: 'business', status: 'received', body, sentAt: now });
  if (isStopMessage(body)) {
    await repo.optOut(c.phoneNorm || `client:${c.id}`, 'sms');
    if (!c.phoneNorm) await repo.updateClient(userId, c.id, { optedOut: true });
    await logActivity(userId, c.id, 'agent', 'optout', `${c.name} texted STOP. They will never be texted again.`);
    return;
  }
  // A reply pauses everything and jumps to the top of the rep's list.
  await repo.updateClient(userId, clientId, { paused: true, lastReplyAt: now });
  await repo.holdScheduled(clientId, 'Client replied');
  const fresh = await repo.getClient(userId, clientId, p.timezone);
  const existing = await repo.openDraftFor(clientId);
  if (existing) await repo.updateMessage(existing.id, { status: 'skipped', error: 'Superseded by a reply' });
  if (fresh) {
    await route(p, fresh, body).catch(async (err) => {
      console.warn('[keepwarm] routing reply failed, drafting for the rep:', err);
      await createDraft(p, fresh, 'reply', firstTypeFor(fresh.mix)).catch(() => {});
    });
    await onReply(p, fresh, body);
  }
}

export async function inbound(from: string, body: string): Promise<number> {
  const phone = repo.normalisePhone(from);
  if (!phone) return 0;
  const matches = await repo.clientsByPhone(phone);
  if (!matches.length && isStopMessage(body)) await repo.optOut(phone, 'sms');
  for (const m of matches) await receiveFor(m.userId, m.id, body);
  return matches.length;
}

/** Outbox mode only: act out a client reply so the flow can be tested end to end. */
export async function simulateReply(p: StoredProfile, clientId: string, body: string): Promise<void> {
  if (smsMode() !== 'outbox') throw new KwError('Simulated replies are only available while texts are not really sent', 403);
  await requireClient(p, clientId);
  if (!body.trim()) throw new KwError('Type the client’s message');
  await receiveFor(p.userId, clientId, body.trim());
}

// ─── Scoreboard ─────────────────────────────────────────────────────────────
const zero = (): KwScore => ({ calls: 0, convos: 0, booked: 0, attended: 0, proposals: 0, pipeline: 0, followups: 0, revenue: 0 });

async function scoreFor(p: StoredProfile, from: string, to: string): Promise<{ total: KwScore; byDay: Map<string, KwScore> }> {
  const [logged, auto] = await Promise.all([repo.loggedByDay(p.userId, from, to), repo.autoByDay(p.userId, from, to, p.timezone)]);
  const byDay = new Map<string, KwScore>();
  const day = (d: string) => byDay.get(d) ?? (byDay.set(d, zero()), byDay.get(d)!);
  for (const r of logged) day(r.day)[r.metric as KwLoggedMetric] += r.total;
  for (const r of auto) {
    day(r.day).pipeline += r.pipeline;
    day(r.day).followups += r.followups;
  }
  const total = zero();
  for (const s of byDay.values()) for (const k of Object.keys(total) as (keyof KwScore)[]) total[k] += s[k];
  return { total, byDay };
}

export async function scoreboard(p: StoredProfile, range: 'day' | 'week'): Promise<KwScoreboard> {
  const today = localDate(new Date(), p.timezone);
  const from = range === 'week' ? weekStart(today) : today;
  const to = range === 'week' ? addDays(from, 6) : today;
  const { total, byDay } = await scoreFor(p, from, to);
  const days = range === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((d) => ({ date: d, score: byDay.get(d) ?? zero() })) : [];
  return { range, from, to, score: total, days };
}

const LOGGABLE: KwLoggedMetric[] = ['calls', 'convos', 'booked', 'attended', 'proposals', 'revenue'];

/** The agent logging a scoreboard input on the rep's behalf (e.g. a call it prompted). */
export async function logScoreAs(p: StoredProfile, metric: KwLoggedMetric, delta: number, source: string): Promise<void> {
  await repo.logScore(p.userId, localDate(new Date(), p.timezone), metric, delta, source);
}

export async function logScore(p: StoredProfile, metric: string, delta: number): Promise<KwScoreboard> {
  if (!LOGGABLE.includes(metric as KwLoggedMetric)) throw new KwError('Follow-ups and pipeline additions count themselves');
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1_000_000) throw new KwError('Invalid amount');
  const today = localDate(new Date(), p.timezone);
  if (delta < 0) {
    const current = (await scoreFor(p, today, today)).total[metric as KwLoggedMetric];
    if (current + delta < 0) throw new KwError('Can’t go below zero');
  }
  await repo.logScore(p.userId, today, metric as KwLoggedMetric, delta, 'tap');
  return scoreboard(p, 'day');
}

export async function logScoreByVoice(p: StoredProfile, sentence: string): Promise<{ added: Partial<Record<KwLoggedMetric, number>>; board: KwScoreboard }> {
  if (!sentence.trim()) throw new KwError('Say what you did today');
  const added = await parseScore(sentence);
  const today = localDate(new Date(), p.timezone);
  for (const [k, v] of Object.entries(added)) await repo.logScore(p.userId, today, k as KwLoggedMetric, v as number, 'voice');
  return { added, board: await scoreboard(p, 'day') };
}

// ─── Team view (managers) ────────────────────────────────────────────────────
export async function team(): Promise<KwTeamRow[]> {
  const users = await query<{ id: string; name: string; email: string }>(
    `SELECT id, name, email FROM users WHERE NOT disabled AND (role = 'rep' OR id IN (SELECT user_id FROM kw_profiles)) ORDER BY name`,
  );
  const rows: KwTeamRow[] = [];
  for (const u of users.rows) {
    const p = await repo.getProfile(u.id);
    if (!p) {
      rows.push({ userId: u.id, name: u.name || u.email, email: u.email, setUp: false, clients: 0, overdue: 0, waitingReplies: 0, draftsWaiting: 0, today: zero(), week: zero(), lastActiveAt: null, sentAsIsPct: null });
      continue;
    }
    const today = localDate(new Date(), p.timezone);
    const [clients, open, day, week, last, asIs] = await Promise.all([
      repo.listClients(u.id, p.timezone),
      repo.listOpen(u.id),
      scoreFor(p, today, today),
      scoreFor(p, weekStart(today), today),
      repo.lastActivity(u.id),
      query<{ sent: string; as_is: string }>(
        `SELECT COUNT(*)::text AS sent, COUNT(*) FILTER (WHERE body = ai_body)::text AS as_is FROM kw_messages
          WHERE user_id = $1 AND direction = 'out' AND status = 'sent' AND sent_at > now() - interval '30 days' AND ai_body <> ''`,
        [u.id],
      ),
    ]);
    const sent = Number(asIs.rows[0]?.sent ?? 0);
    rows.push({
      userId: u.id,
      name: p.displayName || u.name || u.email,
      email: u.email,
      setUp: true,
      clients: clients.filter((c) => !c.optedOut).length,
      overdue: clients.filter((c) => c.nextDue && c.nextDue < addDays(today, -2) && !c.paused && !c.optedOut).length + clients.filter((c) => !c.cadenceDays && !c.optedOut).length,
      waitingReplies: open.filter((m) => m.kind === 'reply' && m.status === 'draft').length,
      draftsWaiting: open.filter((m) => m.kind !== 'reply' && m.status === 'draft').length,
      today: day.total,
      week: week.total,
      lastActiveAt: last,
      sentAsIsPct: sent ? Math.round((Number(asIs.rows[0].as_is) / sent) * 100) : null,
    });
  }
  return rows;
}

// ─── Background loop ────────────────────────────────────────────────────────
let timers: NodeJS.Timeout[] = [];

export function startKeepwarm(): void {
  if (timers.length) return;
  // Every minute: send approved texts whose time has come.
  timers.push(setInterval(() => {
    void (async () => {
      try {
        for (const m of await repo.dueScheduled()) await dispatch(m).catch((err) => console.warn('[keepwarm] dispatch failed:', err));
      } catch (err) {
        console.warn('[keepwarm] dispatch loop:', (err as Error).message);
      }
    })();
  }, 60_000));
  // Every 10 minutes: drafts ready for anyone due, from 5am the rep's time.
  timers.push(setInterval(() => {
    void (async () => {
      try {
        for (const p of await repo.listProfiles()) {
          if (localParts(new Date(), p.timezone).minutes >= 5 * 60) ensureDrafts(p);
        }
      } catch (err) {
        console.warn('[keepwarm] draft loop:', (err as Error).message);
      }
    })();
  }, 10 * 60_000));
  // Every 30 minutes: the pipeline agent reviews each rep's deals.
  timers.push(setInterval(() => { void reviewAll().catch((err) => console.warn('[keepwarm] agent loop:', (err as Error).message)); }, 30 * 60_000));
  for (const t of timers) t.unref?.();
}
