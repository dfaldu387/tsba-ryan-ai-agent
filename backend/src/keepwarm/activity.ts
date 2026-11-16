// Audit trail for the sales pipeline: every change the agent or the rep makes
// to a deal, so a rep can always see what was done on their behalf (and undo
// the agent's own changes).
import type { KwActivity, KwActor, KwStage } from '@tsba/shared';
import { query } from '../db.js';

/** What to restore when the rep undoes an agent change. */
export interface UndoStage {
  type: 'stage';
  clientId: string;
  /** Only undo if the deal is still where the agent put it. */
  toStage: KwStage;
  fromStage: KwStage;
  fromChangedAt: string;
  cadenceDays?: number | null;
  nextDue?: string | null;
}

export async function logActivity(
  userId: string,
  clientId: string | null,
  actor: KwActor,
  action: string,
  detail: string,
  undo?: UndoStage,
): Promise<void> {
  await query(
    'INSERT INTO kw_activity (user_id, client_id, actor, action, detail, undo) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
    [userId, clientId, actor, action, detail.slice(0, 500), undo ? JSON.stringify(undo) : null],
  ).catch((err) => console.warn('[keepwarm] activity log failed:', (err as Error).message));
}

interface ActivityRow {
  id: string; client_id: string | null; client_name: string | null; actor: KwActor; action: string; detail: string;
  undo: UndoStage | null; undone_at: Date | null; created_at: Date;
}

export async function listActivity(userId: string, opts: { clientId?: string; limit?: number } = {}): Promise<KwActivity[]> {
  const vals: unknown[] = [userId];
  let where = 'a.user_id = $1';
  if (opts.clientId) { vals.push(opts.clientId); where += ` AND a.client_id = $${vals.length}`; }
  vals.push(Math.min(200, opts.limit ?? 40));
  const res = await query<ActivityRow>(
    `SELECT a.id::text, a.client_id, c.name AS client_name, a.actor, a.action, a.detail, a.undo, a.undone_at, a.created_at
       FROM kw_activity a LEFT JOIN kw_clients c ON c.id = a.client_id
      WHERE ${where} ORDER BY a.created_at DESC LIMIT $${vals.length}`,
    vals,
  );
  const weekAgo = Date.now() - 7 * 86_400_000;
  return res.rows.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name ?? '',
    actor: r.actor,
    action: r.action,
    detail: r.undone_at ? `${r.detail} (undone)` : r.detail,
    at: r.created_at.toISOString(),
    undoable: r.actor === 'agent' && !!r.undo && !r.undone_at && r.created_at.getTime() > weekAgo,
  }));
}

export async function getUndo(userId: string, id: string): Promise<{ undo: UndoStage | null; undone: boolean } | null> {
  const res = await query<{ undo: UndoStage | null; undone_at: Date | null; actor: KwActor }>(
    'SELECT undo, undone_at, actor FROM kw_activity WHERE id = $1 AND user_id = $2',
    [Number(id) || 0, userId],
  );
  const r = res.rows[0];
  if (!r || r.actor !== 'agent') return null;
  return { undo: r.undo, undone: r.undone_at != null };
}

export async function markUndone(id: string): Promise<void> {
  await query('UPDATE kw_activity SET undone_at = now() WHERE id = $1', [Number(id) || 0]);
}
