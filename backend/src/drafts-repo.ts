import type { Draft, DraftDelivery, DraftResult, SourceCard, Audience, Channel } from '@tsba/shared';
import { query } from './db.js';

interface DraftRow {
  id: string;
  question: string;
  audience: Audience;
  channel: Channel;
  outcome: Draft['outcome'];
  reply: string;
  reply_original: string;
  sources: SourceCard[];
  note_for_ryan: string;
  team_handover: Draft['team_handover'];
  status: Draft['status'];
  edited: boolean;
  recipient: string | null;
  delivery: DraftDelivery | null;
  created_at: Date;
  decided_at: Date | null;
}

const SELECT =
  'id, question, audience, channel, outcome, reply, reply_original, sources, note_for_ryan, team_handover, status, edited, recipient, delivery, created_at, decided_at';

function toDraft(r: DraftRow): Draft {
  return {
    id: Number(r.id),
    question: r.question,
    audience: r.audience,
    channel: r.channel,
    outcome: r.outcome,
    reply: r.reply,
    reply_original: r.reply_original,
    sources: r.sources ?? [],
    note_for_ryan: r.note_for_ryan,
    team_handover: r.team_handover ?? null,
    status: r.status,
    edited: r.edited,
    recipient: r.recipient ?? null,
    delivery: r.delivery ?? null,
    created_at: r.created_at.toISOString(),
    decided_at: r.decided_at ? r.decided_at.toISOString() : null,
  };
}

export async function insertDraft(args: {
  question: string;
  audience: Audience;
  channel: Channel;
  result: DraftResult;
  sources: SourceCard[];
  recipient?: string | null;
}): Promise<Draft> {
  const { question, audience, channel, result, sources, recipient } = args;
  const res = await query<DraftRow>(
    `INSERT INTO drafts
       (question, audience, channel, outcome, reply, reply_original, sources, note_for_ryan, team_handover, recipient)
     VALUES ($1,$2,$3,$4,$5,$5,$6::jsonb,$7,$8::jsonb,$9)
     RETURNING ${SELECT}`,
    [
      question,
      audience,
      channel,
      result.outcome,
      result.reply,
      JSON.stringify(sources),
      result.note_for_ryan,
      result.team_handover ? JSON.stringify(result.team_handover) : null,
      recipient ?? null,
    ],
  );
  return toDraft(res.rows[0]);
}

/** Record the outcome of dispatching an approved reply. */
export async function recordDraftDelivery(id: number, delivery: DraftDelivery): Promise<Draft | null> {
  const res = await query<DraftRow>(
    `UPDATE drafts SET delivery = $1::jsonb WHERE id = $2 RETURNING ${SELECT}`,
    [JSON.stringify(delivery), id],
  );
  return res.rows[0] ? toDraft(res.rows[0]) : null;
}

export async function listDrafts(): Promise<Draft[]> {
  const res = await query<DraftRow>(`SELECT ${SELECT} FROM drafts ORDER BY created_at ASC`);
  return res.rows.map(toDraft);
}

export async function getDraft(id: number): Promise<Draft | null> {
  const res = await query<DraftRow>(`SELECT ${SELECT} FROM drafts WHERE id = $1`, [id]);
  return res.rows[0] ? toDraft(res.rows[0]) : null;
}

/** Approve/reject/edit. Returns the updated draft, or null if not found. */
export async function updateDraft(
  id: number,
  action: 'approve' | 'reject' | 'edit',
  text?: string,
): Promise<Draft | null> {
  const existing = await getDraft(id);
  if (!existing) return null;

  if (action === 'edit') {
    const newText = (text ?? '').trim();
    const edited = newText !== existing.reply_original.trim();
    const res = await query<DraftRow>(
      `UPDATE drafts SET reply = $1, edited = $2 WHERE id = $3 RETURNING ${SELECT}`,
      [newText, edited, id],
    );
    return toDraft(res.rows[0]);
  }

  if (action === 'approve') {
    const status: Draft['status'] = existing.outcome === 'handover' ? 'team' : 'sent';
    const newText = text !== undefined ? text.trim() : existing.reply;
    const edited = existing.edited || newText !== existing.reply_original.trim();
    const res = await query<DraftRow>(
      `UPDATE drafts SET status = $1, reply = $2, edited = $3, decided_at = now() WHERE id = $4 RETURNING ${SELECT}`,
      [status, newText, edited, id],
    );
    return toDraft(res.rows[0]);
  }

  // reject
  const res = await query<DraftRow>(
    `UPDATE drafts SET status = 'rejected', decided_at = now() WHERE id = $1 RETURNING ${SELECT}`,
    [id],
  );
  return toDraft(res.rows[0]);
}
