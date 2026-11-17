// Postgres access for the sales follow-up agent. Every query is scoped by the
// rep's user id so a rep can only ever read or change their own clients.
import { randomUUID } from 'node:crypto';
import type {
  KwClient, KwLoggedMetric, KwMessage, KwMessageKind, KwMessageStatus, KwMix, KwNote,
  KwConvo, KwProfile, KwSender, KwStage, KwTextType, KwTone, KwUnderstood, KwWarmth,
} from '@tsba/shared';
import { query, withTransaction } from '../db.js';
import { daysBetween, localDate } from './time.js';

export const newId = (): string => randomUUID();

/** Australian-friendly E.164 normalisation: 0412 345 678 → +61412345678. */
export function normalisePhone(raw: string): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (plus) return `+${digits}`;
  if (digits.startsWith('61')) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+61${digits.slice(1)}`;
  if (digits.startsWith('4') && digits.length === 9) return `+61${digits}`;
  return `+${digits}`;
}

// ─── Profiles ───────────────────────────────────────────────────────────────
interface ProfileRow {
  user_id: string; display_name: string; company: string; sign_off: string; about: string;
  understood: KwUnderstood | Record<string, never>; tone: KwTone; send_time: string; timezone: string;
  sms_from: string;
}

export interface StoredProfile extends KwProfile {
  userId: string;
  smsFrom: string;
}

function toProfile(r: ProfileRow): StoredProfile {
  const u = r.understood as Partial<KwUnderstood>;
  return {
    userId: r.user_id,
    displayName: r.display_name,
    company: r.company,
    signOff: r.sign_off,
    about: r.about,
    understood: u && u.sells ? (u as KwUnderstood) : null,
    tone: r.tone,
    sendTime: r.send_time,
    timezone: r.timezone,
    smsFrom: r.sms_from,
  };
}

export async function getProfile(userId: string): Promise<StoredProfile | null> {
  const res = await query<ProfileRow>('SELECT * FROM kw_profiles WHERE user_id = $1', [userId]);
  return res.rows[0] ? toProfile(res.rows[0]) : null;
}

export async function listProfiles(): Promise<StoredProfile[]> {
  const res = await query<ProfileRow>('SELECT * FROM kw_profiles');
  return res.rows.map(toProfile);
}

export async function upsertProfile(userId: string, p: KwProfile): Promise<StoredProfile> {
  const res = await query<ProfileRow>(
    `INSERT INTO kw_profiles (user_id, display_name, company, sign_off, about, understood, tone, send_time, timezone)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     ON CONFLICT (user_id) DO UPDATE SET
       display_name = EXCLUDED.display_name, company = EXCLUDED.company, sign_off = EXCLUDED.sign_off,
       about = EXCLUDED.about, understood = EXCLUDED.understood, tone = EXCLUDED.tone,
       send_time = EXCLUDED.send_time, timezone = EXCLUDED.timezone, updated_at = now()
     RETURNING *`,
    [userId, p.displayName, p.company, p.signOff, p.about, JSON.stringify(p.understood ?? {}), p.tone, p.sendTime, p.timezone],
  );
  return toProfile(res.rows[0]);
}

// ─── Clients ────────────────────────────────────────────────────────────────
export interface ClientRow {
  id: string; user_id: string; name: string; phone: string; phone_norm: string; email: string; stage: string;
  notes: KwNote[]; cadence_days: number | null; mix: KwMix; next_type: KwTextType; send_time: string | null;
  next_due: string | Date | null; paused: boolean; opted_out_at: Date | null; last_contact_at: Date | null;
  last_reply_at: Date | null; created_at: Date;
  deal_stage: KwStage; deal_value: string | number | null; stage_changed_at: Date; expected_close: string | Date | null;
  lost_reason: string; convo: KwConvo; convo_since: Date | null; convo_reason: string; rep_typing_at: Date | null;
}

export interface StoredClient extends KwClient {
  userId: string;
  phoneNorm: string;
  repTypingAt: string | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const dateStr = (d: string | Date | null): string | null =>
  d == null ? null : typeof d === 'string' ? d.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The warmth ring: full right after contact, drains to empty on the due day. */
export function warmthOf(c: Pick<StoredClient, 'paused' | 'optedOut' | 'cadenceDays' | 'nextDue'>, today: string, lastContactDays: number | null): { warmth: KwWarmth; pct: number } {
  if (c.optedOut) return { warmth: 'stopped', pct: 0 };
  if (c.paused) return { warmth: 'paused', pct: 100 };
  if (!c.cadenceDays || !c.nextDue) return { warmth: 'cold', pct: 0 };
  const left = daysBetween(today, c.nextDue);
  if (left < 0) return { warmth: 'cold', pct: 0 };
  if (left === 0) return { warmth: 'due', pct: 0 };
  const pct = Math.max(4, Math.min(100, Math.round((left / c.cadenceDays) * 100)));
  void lastContactDays;
  return { warmth: pct <= 40 ? 'cooling' : 'warm', pct };
}

export function toClient(r: ClientRow, tz: string): StoredClient {
  const today = localDate(new Date(), tz);
  const lastDays = r.last_contact_at ? daysBetween(localDate(r.last_contact_at, tz), today) : null;
  const base = {
    id: r.id,
    userId: r.user_id,
    repTypingAt: iso(r.rep_typing_at ?? null),
    name: r.name,
    phone: r.phone,
    phoneNorm: r.phone_norm,
    email: r.email,
    stage: r.stage,
    notes: Array.isArray(r.notes) ? r.notes : [],
    cadenceDays: r.cadence_days,
    mix: r.mix,
    nextType: r.next_type,
    sendTime: r.send_time,
    nextDue: dateStr(r.next_due),
    paused: r.paused,
    optedOut: r.opted_out_at != null,
    lastContactAt: iso(r.last_contact_at),
    lastReplyAt: iso(r.last_reply_at),
    createdAt: r.created_at.toISOString(),
    daysSinceContact: lastDays,
    dealStage: r.deal_stage ?? 'lead',
    dealValue: r.deal_value == null ? null : Number(r.deal_value),
    stageChangedAt: (r.stage_changed_at ?? r.created_at).toISOString(),
    daysInStage: daysBetween(localDate(r.stage_changed_at ?? r.created_at, tz), today),
    expectedClose: dateStr(r.expected_close),
    lostReason: r.lost_reason ?? '',
    convo: r.convo ?? 'idle',
    convoSince: iso(r.convo_since ?? null),
    convoReason: r.convo_reason ?? '',
  };
  const w = warmthOf(base, today, lastDays);
  return { ...base, warmth: w.warmth, warmthPct: w.pct };
}

export async function listClients(userId: string, tz: string): Promise<StoredClient[]> {
  const res = await query<ClientRow>('SELECT * FROM kw_clients WHERE user_id = $1 ORDER BY name', [userId]);
  return res.rows.map((r) => toClient(r, tz));
}

export async function getClient(userId: string, id: string, tz: string): Promise<StoredClient | null> {
  const res = await query<ClientRow>('SELECT * FROM kw_clients WHERE id = $1 AND user_id = $2', [id, userId]);
  return res.rows[0] ? toClient(res.rows[0], tz) : null;
}

export async function clientsByPhone(phoneNorm: string): Promise<{ id: string; userId: string }[]> {
  const res = await query<{ id: string; user_id: string }>('SELECT id, user_id FROM kw_clients WHERE phone_norm = $1', [phoneNorm]);
  return res.rows.map((r) => ({ id: r.id, userId: r.user_id }));
}

export async function insertClient(userId: string, c: { name: string; phone: string; email?: string; stage?: string; dealStage?: KwStage; dealValue?: number | null }): Promise<string> {
  const id = newId();
  const phoneNorm = normalisePhone(c.phone);
  const optedOut = phoneNorm ? await isOptedOut(phoneNorm) : false;
  await query(
    `INSERT INTO kw_clients (id, user_id, name, phone, phone_norm, email, stage, deal_stage, deal_value, opted_out_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${optedOut ? 'now()' : 'NULL'})`,
    [id, userId, c.name.trim(), c.phone.trim(), phoneNorm, (c.email ?? '').trim(), (c.stage ?? '').trim(), c.dealStage ?? 'lead', c.dealValue ?? null],
  );
  return id;
}

export interface ClientPatch {
  name?: string; phone?: string; email?: string; stage?: string; notes?: KwNote[]; transcript?: string;
  cadenceDays?: number | null; mix?: KwMix; nextType?: KwTextType; sendTime?: string | null; nextDue?: string | null;
  paused?: boolean; lastContactAt?: Date; lastReplyAt?: Date; optedOut?: boolean;
  dealStage?: KwStage; dealValue?: number | null; expectedClose?: string | null; lostReason?: string;
  convo?: KwConvo; convoReason?: string; repTypingAt?: Date | null;
}

export async function updateClient(userId: string, id: string, p: ClientPatch): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown, cast = '') => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
  if (p.name !== undefined) set('name', p.name.trim());
  if (p.phone !== undefined) { set('phone', p.phone.trim()); set('phone_norm', normalisePhone(p.phone)); }
  if (p.email !== undefined) set('email', p.email.trim());
  if (p.stage !== undefined) set('stage', p.stage.trim());
  if (p.notes !== undefined) set('notes', JSON.stringify(p.notes), '::jsonb');
  if (p.transcript) { vals.push(JSON.stringify([{ at: new Date().toISOString(), text: p.transcript }])); sets.push(`transcripts = transcripts || $${vals.length}::jsonb`); }
  if (p.cadenceDays !== undefined) set('cadence_days', p.cadenceDays);
  if (p.mix !== undefined) set('mix', p.mix);
  if (p.nextType !== undefined) set('next_type', p.nextType);
  if (p.sendTime !== undefined) set('send_time', p.sendTime);
  if (p.nextDue !== undefined) set('next_due', p.nextDue);
  if (p.paused !== undefined) set('paused', p.paused);
  if (p.lastContactAt !== undefined) set('last_contact_at', p.lastContactAt);
  if (p.lastReplyAt !== undefined) set('last_reply_at', p.lastReplyAt);
  if (p.dealStage !== undefined) { set('deal_stage', p.dealStage); sets.push('stage_changed_at = now()'); }
  if (p.dealValue !== undefined) set('deal_value', p.dealValue);
  if (p.expectedClose !== undefined) set('expected_close', p.expectedClose);
  if (p.lostReason !== undefined) set('lost_reason', p.lostReason.trim().slice(0, 300));
  if (p.convo !== undefined) { set('convo', p.convo); sets.push('convo_since = now()'); }
  if (p.convoReason !== undefined) set('convo_reason', p.convoReason.slice(0, 300));
  if (p.repTypingAt !== undefined) set('rep_typing_at', p.repTypingAt);
  if (p.optedOut !== undefined) sets.push(p.optedOut ? 'opted_out_at = COALESCE(opted_out_at, now())' : 'opted_out_at = NULL');
  if (!sets.length) return;
  vals.push(id, userId);
  await query(`UPDATE kw_clients SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length - 1} AND user_id = $${vals.length}`, vals);
}

export async function deleteClient(userId: string, id: string): Promise<void> {
  await query('DELETE FROM kw_clients WHERE id = $1 AND user_id = $2', [id, userId]);
}

// ─── Opt-outs ───────────────────────────────────────────────────────────────
export async function isOptedOut(phoneNorm: string): Promise<boolean> {
  if (!phoneNorm) return false;
  const res = await query('SELECT 1 FROM kw_optouts WHERE phone_norm = $1', [phoneNorm]);
  return (res.rowCount ?? 0) > 0;
}

/** Record a STOP: the number is blocked for every rep, and nothing queued goes out. */
export async function optOut(phoneNorm: string, source: string): Promise<void> {
  // All or nothing: a half-applied opt-out could leave texts queued to someone who said stop.
  await withTransaction(async (q) => {
    await q('INSERT INTO kw_optouts (phone_norm, source) VALUES ($1, $2) ON CONFLICT DO NOTHING', [phoneNorm, source]);
    await q('UPDATE kw_clients SET opted_out_at = COALESCE(opted_out_at, now()), paused = false, updated_at = now() WHERE phone_norm = $1', [phoneNorm]);
    await q(
      `UPDATE kw_messages SET status = 'skipped', error = 'Client opted out', updated_at = now()
        WHERE status IN ('draft', 'scheduled') AND direction = 'out'
          AND client_id IN (SELECT id FROM kw_clients WHERE phone_norm = $1)`,
      [phoneNorm],
    );
  });
}

// ─── Messages ───────────────────────────────────────────────────────────────
export interface MessageRow {
  id: string; user_id: string; client_id: string; direction: 'out' | 'in'; kind: KwMessageKind; type: KwTextType;
  status: KwMessageStatus; body: string; ai_body: string; used_notes: string[]; approved_at: Date | null;
  scheduled_for: Date | null; sent_at: Date | null; provider_id: string | null; error: string | null; created_at: Date;
  sent_by: KwSender;
}

export interface StoredMessage extends KwMessage {
  userId: string;
  aiBody: string;
}

export function toMessage(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    userId: r.user_id,
    clientId: r.client_id,
    direction: r.direction,
    kind: r.kind,
    type: r.type,
    status: r.status,
    body: r.body,
    aiBody: r.ai_body,
    usedNotes: Array.isArray(r.used_notes) ? r.used_notes : [],
    approvedAt: iso(r.approved_at),
    scheduledFor: iso(r.scheduled_for),
    sentAt: iso(r.sent_at),
    error: r.error,
    createdAt: r.created_at.toISOString(),
    sentBy: r.sent_by ?? 'rep',
  };
}

export async function getMessage(userId: string, id: string): Promise<StoredMessage | null> {
  const res = await query<MessageRow>('SELECT * FROM kw_messages WHERE id = $1 AND user_id = $2', [id, userId]);
  return res.rows[0] ? toMessage(res.rows[0]) : null;
}

export async function listThread(userId: string, clientId: string): Promise<StoredMessage[]> {
  const res = await query<MessageRow>(
    `SELECT * FROM kw_messages WHERE user_id = $1 AND client_id = $2
       AND status IN ('sent', 'received', 'scheduled', 'failed', 'held')
     ORDER BY COALESCE(sent_at, scheduled_for, created_at)`,
    [userId, clientId],
  );
  return res.rows.map(toMessage);
}

/** Open outbound items for a rep: drafts awaiting approval and approved-but-waiting texts. */
export async function listOpen(userId: string): Promise<StoredMessage[]> {
  const res = await query<MessageRow>(
    `SELECT * FROM kw_messages WHERE user_id = $1 AND direction = 'out' AND status IN ('draft', 'scheduled')
     ORDER BY created_at`,
    [userId],
  );
  return res.rows.map(toMessage);
}

export async function openDraftFor(clientId: string): Promise<StoredMessage | null> {
  const res = await query<MessageRow>(
    `SELECT * FROM kw_messages WHERE client_id = $1 AND direction = 'out' AND status = 'draft' ORDER BY created_at DESC LIMIT 1`,
    [clientId],
  );
  return res.rows[0] ? toMessage(res.rows[0]) : null;
}

export async function insertMessage(m: {
  userId: string; clientId: string; direction: 'out' | 'in'; kind: KwMessageKind; type: KwTextType;
  status: KwMessageStatus; body: string; usedNotes?: string[]; sentAt?: Date; providerId?: string;
  sentBy?: KwSender; approvedAt?: Date; scheduledFor?: Date;
}): Promise<StoredMessage> {
  const res = await query<MessageRow>(
    `INSERT INTO kw_messages (id, user_id, client_id, direction, kind, type, status, body, ai_body, used_notes, sent_at, provider_id, sent_by, approved_at, scheduled_for)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9::jsonb, $10, $11, $12, $13, $14) RETURNING *`,
    [newId(), m.userId, m.clientId, m.direction, m.kind, m.type, m.status, m.body, JSON.stringify(m.usedNotes ?? []), m.sentAt ?? null, m.providerId ?? null,
      m.sentBy ?? 'rep', m.approvedAt ?? null, m.scheduledFor ?? null],
  );
  return toMessage(res.rows[0]);
}

export async function updateMessage(id: string, p: {
  body?: string; aiBody?: string; type?: KwTextType; status?: KwMessageStatus; usedNotes?: string[];
  approvedAt?: Date | null; scheduledFor?: Date | null; sentAt?: Date | null; providerId?: string | null; error?: string | null;
}): Promise<StoredMessage> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown, cast = '') => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
  if (p.body !== undefined) set('body', p.body);
  if (p.aiBody !== undefined) set('ai_body', p.aiBody);
  if (p.type !== undefined) set('type', p.type);
  if (p.status !== undefined) set('status', p.status);
  if (p.usedNotes !== undefined) set('used_notes', JSON.stringify(p.usedNotes), '::jsonb');
  if (p.approvedAt !== undefined) set('approved_at', p.approvedAt);
  if (p.scheduledFor !== undefined) set('scheduled_for', p.scheduledFor);
  if (p.sentAt !== undefined) set('sent_at', p.sentAt);
  if (p.providerId !== undefined) set('provider_id', p.providerId);
  if (p.error !== undefined) set('error', p.error);
  vals.push(id);
  const res = await query<MessageRow>(`UPDATE kw_messages SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
  return toMessage(res.rows[0]);
}

/** Cancel a client's pending scheduled texts (used when they reply mid-rhythm). */
export async function holdScheduled(clientId: string, reason: string): Promise<void> {
  // One statement, so a client's scheduled and draft texts are held together.
  await query(
    `UPDATE kw_messages
        SET status = CASE status WHEN 'scheduled' THEN 'held' ELSE 'skipped' END,
            error = $2, updated_at = now()
      WHERE client_id = $1 AND direction = 'out' AND status IN ('scheduled', 'draft') AND kind <> 'reply'`,
    [clientId, reason],
  );
}

/**
 * Atomically claim one due text for sending. Moves its send time 10 minutes out
 * as a lease, so a concurrent loop tick, an approve click or a second process
 * can't pick up the same row; dispatch then sets the final status. Returns
 * null when someone else already claimed it (or it's no longer due).
 */
export async function claimForSend(id: string): Promise<StoredMessage | null> {
  const res = await query<MessageRow>(
    `UPDATE kw_messages SET scheduled_for = now() + interval '10 minutes', updated_at = now()
      WHERE id = $1 AND status = 'scheduled' AND scheduled_for <= now()
      RETURNING *`,
    [id],
  );
  return res.rows[0] ? toMessage(res.rows[0]) : null;
}

/** Approved texts whose send time has come, across all reps. */
export async function dueScheduled(limit = 25): Promise<StoredMessage[]> {
  const res = await query<MessageRow>(
    `SELECT * FROM kw_messages WHERE status = 'scheduled' AND scheduled_for <= now() ORDER BY scheduled_for LIMIT $1`,
    [limit],
  );
  return res.rows.map(toMessage);
}

// ─── Scoreboard ─────────────────────────────────────────────────────────────
export async function logScore(userId: string, day: string, metric: KwLoggedMetric, value: number, source: string): Promise<void> {
  await query('INSERT INTO kw_score_events (user_id, day, metric, value, source) VALUES ($1, $2, $3, $4, $5)', [userId, day, metric, value, source]);
}

/** Logged metric sums per local day, for a date range. */
export async function loggedByDay(userId: string, from: string, to: string): Promise<{ day: string; metric: string; total: number }[]> {
  const res = await query<{ day: string; metric: string; total: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, metric, SUM(value)::text AS total FROM kw_score_events
      WHERE user_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day, metric`,
    [userId, from, to],
  );
  return res.rows.map((r) => ({ day: r.day, metric: r.metric, total: Number(r.total) }));
}

/** Auto-counted metrics per local day: new clients (pipeline) and clients texted (follow-ups). */
export async function autoByDay(userId: string, from: string, to: string, tz: string): Promise<{ day: string; pipeline: number; followups: number }[]> {
  const res = await query<{ day: string; pipeline: string; followups: string }>(
    `WITH p AS (
       SELECT to_char(created_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, COUNT(*) AS n FROM kw_clients
        WHERE user_id = $1 AND (created_at AT TIME ZONE $4)::date BETWEEN $2 AND $3 GROUP BY 1),
     f AS (
       SELECT to_char(sent_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, COUNT(DISTINCT client_id) AS n FROM kw_messages
        WHERE user_id = $1 AND direction = 'out' AND status = 'sent' AND (sent_at AT TIME ZONE $4)::date BETWEEN $2 AND $3 GROUP BY 1)
     SELECT COALESCE(p.day, f.day) AS day, COALESCE(p.n, 0)::text AS pipeline, COALESCE(f.n, 0)::text AS followups
       FROM p FULL OUTER JOIN f ON p.day = f.day`,
    [userId, from, to, tz],
  );
  return res.rows.map((r) => ({ day: r.day, pipeline: Number(r.pipeline), followups: Number(r.followups) }));
}

export async function lastActivity(userId: string): Promise<string | null> {
  const res = await query<{ at: Date | null }>(
    `SELECT GREATEST(
       (SELECT MAX(approved_at) FROM kw_messages WHERE user_id = $1),
       (SELECT MAX(created_at) FROM kw_clients WHERE user_id = $1),
       (SELECT MAX(created_at) FROM kw_score_events WHERE user_id = $1)) AS at`,
    [userId],
  );
  return iso(res.rows[0]?.at ?? null);
}

/** Cancel the agent's own replies that haven't gone out yet (the rep took over). */
export async function cancelAgentReplies(clientId: string, reason: string): Promise<number> {
  const res = await query(
    `UPDATE kw_messages SET status = 'held', error = $2, updated_at = now()
      WHERE client_id = $1 AND sent_by = 'agent' AND status = 'scheduled'`,
    [clientId, reason],
  );
  return res.rowCount ?? 0;
}

/** Agent texts sent to one client in the last 24 hours (the per-client cap). */
export async function agentSentRecently(clientId: string): Promise<number> {
  const res = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM kw_messages WHERE client_id = $1 AND sent_by = 'agent'
        AND status IN ('sent', 'scheduled') AND created_at > now() - interval '24 hours'`,
    [clientId],
  );
  return Number(res.rows[0]?.n ?? 0);
}
