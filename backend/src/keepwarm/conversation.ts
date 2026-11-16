// Who answers a client: the agent or the rep.
//
// Only active when Sales settings → auto-replies is ON (off by default, because
// it relaxes the "rep approves every text" rule). With it off, every reply is a
// draft for the rep, exactly as before.
//
//   idle ──client replies──▶ agent  (routine message: agent answers in the rep's name)
//     ▲                        │
//     │                        ├─ rep sends/typing/"Take over" ─▶ rep
//     │                        └─ price, complaint, "call me", unsure, cap ─▶ rep (handed over)
//     └──── rep taps "Hand back" (agent suggests it when the chat looks finished) ── rep
//
// Safety at send time (dispatch in service.ts calls canAgentSend): the setting
// is still on, the agent still owns the conversation, the rep isn't typing,
// and nothing new arrived. Agent replies wait AGENT_DELAY_MIN so the rep can
// step in first. STOP and quiet hours apply exactly as for the rep's texts.
import { kwStageLabel } from '@tsba/shared';
import { logActivity } from './activity.js';
import { autoReplyDecision, conversationEnded, summariseConversation } from './ai.js';
import * as repo from './repo.js';
import type { StoredClient, StoredMessage, StoredProfile } from './repo.js';
import { settings } from './settings.js';
import { nextAllowed } from './time.js';
import { createDraft } from './service.js';

export const AGENT_DELAY_MIN = 2;
const DAILY_CAP = 3; // agent texts per client per 24h before a human must step in
const firstName = (n: string) => n.trim().split(/[\s&]+/)[0] || n;

const threadOf = async (p: StoredProfile, c: StoredClient) =>
  (await repo.listThread(p.userId, c.id)).filter((m) => m.status === 'sent' || m.status === 'received');

/** A rep-facing draft answer, the pre-existing behaviour. */
async function draftForRep(p: StoredProfile, c: StoredClient): Promise<void> {
  await createDraft(p, c, 'reply', c.mix === 'friendly' ? 'friendly' : 'business').catch((err) => console.warn('[keepwarm] reply draft failed:', err));
}

/** A client message arrived (not STOP). Decide who answers it. */
export async function route(p: StoredProfile, c: StoredClient, body: string): Promise<void> {
  // Anything the agent had queued is now out of date.
  await repo.cancelAgentReplies(c.id, 'The client wrote again before it went out');

  const s = settings();
  if (!s.autoReply || c.convo === 'rep' || c.dealStage === 'won' || c.dealStage === 'lost') {
    await draftForRep(p, c);
    return;
  }
  const handOver = async (reason: string) => {
    await repo.updateClient(p.userId, c.id, { convo: 'rep', convoReason: reason });
    await logActivity(p.userId, c.id, 'agent', 'handover', `Handed ${c.name} to you: ${reason.replace(/\.$/, '')}.`);
    await draftForRep(p, c);
  };
  if ((await repo.agentSentRecently(c.id)) >= DAILY_CAP) {
    await handOver(`I’ve already sent ${DAILY_CAP} texts today, so a real person should pick it up`);
    return;
  }
  const thread = await threadOf(p, c);
  const d = await autoReplyDecision(
    {
      profile: p,
      client: { name: c.name, stage: c.stage || kwStageLabel(c.dealStage), notes: c.notes },
      thread: thread.map((m) => ({ direction: m.direction, body: m.body, at: m.sentAt ?? m.createdAt })),
    },
    body,
  );
  if (!d.handle) {
    await handOver(d.reason);
    return;
  }
  if (!d.text) {
    // e.g. a final "thanks": nothing to say back. Nobody is left waiting, so the rhythm carries on.
    await repo.updateClient(p.userId, c.id, { convo: 'agent', convoReason: d.reason, paused: false });
    await logActivity(p.userId, c.id, 'agent', 'auto_none', `${c.name}’s message didn’t need an answer (${d.reason.replace(/\.$/, '').toLowerCase()}), so I didn’t send one.`);
    return;
  }
  const now = new Date();
  const at = nextAllowed(new Date(now.getTime() + AGENT_DELAY_MIN * 60_000), p.timezone);
  await repo.insertMessage({
    userId: p.userId, clientId: c.id, direction: 'out', kind: 'reply', type: 'business', status: 'scheduled',
    body: d.text, sentBy: 'agent', approvedAt: now, scheduledFor: at,
  });
  if (c.convo !== 'agent') await repo.updateClient(p.userId, c.id, { convo: 'agent', convoReason: d.reason });
  else await repo.updateClient(p.userId, c.id, { convoReason: d.reason });
  await logActivity(p.userId, c.id, 'agent', 'auto_queued', `Answering ${c.name} for you (${d.reason.replace(/\.$/, '').toLowerCase()}). Goes out in ${AGENT_DELAY_MIN} min unless you take over.`);
}

/** The rep steps in. Cancels anything the agent was about to send. */
export async function takeOver(p: StoredProfile, c: StoredClient, why: string): Promise<boolean> {
  if (c.convo === 'rep') return false;
  const wasAgent = c.convo === 'agent';
  await repo.updateClient(p.userId, c.id, { convo: 'rep', convoReason: why });
  const cancelled = await repo.cancelAgentReplies(c.id, 'You took over');
  if (wasAgent || cancelled) {
    await logActivity(p.userId, c.id, 'rep', 'takeover', `Took over the conversation with ${c.name} (${why.toLowerCase()})${cancelled ? '. The agent’s pending reply was cancelled.' : '.'}`);
  }
  // A rep-handled reply still needs a draft so nothing is left unanswered.
  if (c.paused && !(await repo.openDraftFor(c.id))) await draftForRep(p, c);
  return true;
}

/** Rep typed in a reply box for this client. Typing is a takeover when the agent is talking. */
export async function typing(p: StoredProfile, c: StoredClient): Promise<{ tookOver: boolean }> {
  await repo.updateClient(p.userId, c.id, { repTypingAt: new Date() });
  if (c.convo === 'agent') return { tookOver: await takeOver(p, c, 'You started typing') };
  return { tookOver: false };
}

/** Rep is done: the agent may answer this client again. Saves a one-line memory of the chat. */
export async function handBack(p: StoredProfile, c: StoredClient, outcome?: string): Promise<{ note: string }> {
  const thread = await threadOf(p, c);
  const since = c.convoSince ? Date.parse(c.convoSince) : 0;
  const recent = thread.filter((m) => Date.parse(m.sentAt ?? m.createdAt) >= since - 86_400_000);
  const summary = await summariseConversation(recent.map((m) => ({ direction: m.direction, body: m.body })), c.name).catch(() => '');
  const line = [summary, outcome?.trim()].filter(Boolean).join(' · ');
  const patch: repo.ClientPatch = { convo: 'idle', convoReason: '' };
  if (line) {
    const date = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: p.timezone });
    patch.notes = [{ id: repo.newId().slice(0, 8), cat: 'situation', text: `Chat ${date}: ${line}`.slice(0, 220) }, ...c.notes];
  }
  await repo.updateClient(p.userId, c.id, patch);
  await logActivity(p.userId, c.id, 'rep', 'handback', `Handed ${c.name} back to the agent${line ? `. Saved to notes: “${line}”` : '.'}`);
  return { note: line ? 'Handed back. Summary saved to their notes.' : 'Handed back to the agent.' };
}

/**
 * Last check before an agent reply leaves. Returns a reason to stop, or null to send.
 * `postpone` = try again shortly (rep may be typing).
 */
export function agentSendBlock(m: StoredMessage, c: StoredClient): { status: 'held' | 'postpone'; why: string } | null {
  if (!settings().autoReply) return { status: 'held', why: 'Auto-replies were switched off' };
  if (c.convo !== 'agent') return { status: 'held', why: 'You took over the conversation' };
  if (c.repTypingAt && Date.now() - Date.parse(c.repTypingAt) < AGENT_DELAY_MIN * 60_000) return { status: 'postpone', why: 'You were typing' };
  if (c.lastReplyAt && Date.parse(c.lastReplyAt) > Date.parse(m.createdAt) + 1000) return { status: 'held', why: 'The client wrote again' };
  return null;
}

// ─── Handback suggestions (run by the agent's review pass) ──────────────────
const endedCache = new Map<string, { lastId: string; ended: boolean; why: string }>();

/** Should the agent suggest the rep hands this conversation back? Returns a reason or null. */
export async function handbackReason(p: StoredProfile, c: StoredClient): Promise<string | null> {
  if (!settings().autoReply || c.convo !== 'rep' || c.paused || c.optedOut) return null; // paused = client is waiting on the rep
  const thread = await threadOf(p, c);
  const last = thread[thread.length - 1];
  if (!last) return null;
  const since = c.convoSince ? Date.parse(c.convoSince) : 0;
  if (Date.parse(c.stageChangedAt) > since) return `The deal moved to ${kwStageLabel(c.dealStage)} since you took over.`;
  const age = Date.now() - Date.parse(last.sentAt ?? last.createdAt);
  if (last.direction === 'out' && age > 24 * 3600_000) return `No reply from ${firstName(c.name)} for a day since your last text.`;
  if (age < 30 * 60_000) return null; // give a live chat time to breathe
  let hit = endedCache.get(c.id);
  if (!hit || hit.lastId !== last.id) {
    const r = await conversationEnded(thread.map((m) => ({ direction: m.direction, body: m.body })), p.displayName);
    hit = { lastId: last.id, ...r };
    endedCache.set(c.id, hit);
  }
  return hit.ended ? `The chat looks finished${hit.why ? ` (${hit.why.replace(/\.$/, '').toLowerCase()})` : ''}.` : null;
}
