// Cross-rep read models for the Sales admin area (requires `sales_team`).
// Reps never reach these: every rep endpoint stays scoped to its own user id.
import type { KwAdminClient, KwAdminMessage, KwMessageStatus, KwOptOut } from '@tsba/shared';
import { query } from '../db.js';
import { toClient, toMessage, type ClientRow, type MessageRow } from './repo.js';
import { publicClient, publicMessage } from './service.js';

const DEFAULT_TZ = 'Australia/Sydney';

/** Every rep's clients, with the rep's name, warmth computed in the rep's zone. */
export async function allClients(): Promise<KwAdminClient[]> {
  const res = await query<ClientRow & { rep_name: string; tz: string | null }>(
    `SELECT c.*, COALESCE(NULLIF(p.display_name, ''), NULLIF(u.name, ''), u.email) AS rep_name, p.timezone AS tz
       FROM kw_clients c JOIN users u ON u.id = c.user_id LEFT JOIN kw_profiles p ON p.user_id = c.user_id
      ORDER BY c.name`,
  );
  return res.rows.map((r) => ({ ...publicClient(toClient(r, r.tz ?? DEFAULT_TZ)), repId: r.user_id, repName: r.rep_name }));
}

export interface MessageFilter {
  status?: string;
  direction?: string;
  repId?: string;
  q?: string;
  limit?: number;
}

const STATUSES: KwMessageStatus[] = ['draft', 'scheduled', 'sent', 'failed', 'skipped', 'held', 'received'];

/** The text log across the team, newest first. */
export async function allMessages(f: MessageFilter): Promise<KwAdminMessage[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  // `$?` in a clause is replaced by this value's parameter index (every occurrence).
  const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.split('$?').join(`$${vals.length}`)); };
  if (f.status && STATUSES.includes(f.status as KwMessageStatus)) add('m.status = $?', f.status);
  // Default view: what actually happened (approved/sent/replies), not unapproved AI drafts.
  else where.push(`m.status NOT IN ('draft', 'skipped')`);
  if (f.direction === 'in' || f.direction === 'out') add('m.direction = $?', f.direction);
  if (f.repId) add('m.user_id = $?', f.repId);
  if (f.q?.trim()) add('(m.body ILIKE $? OR c.name ILIKE $?)', `%${f.q.trim()}%`);
  vals.push(Math.min(500, Math.max(1, f.limit ?? 200)));
  const whereSql = where;
  const res = await query<MessageRow & { client_name: string; rep_name: string }>(
    `SELECT m.*, c.name AS client_name, COALESCE(NULLIF(p.display_name, ''), NULLIF(u.name, ''), u.email) AS rep_name
       FROM kw_messages m JOIN kw_clients c ON c.id = m.client_id JOIN users u ON u.id = m.user_id
       LEFT JOIN kw_profiles p ON p.user_id = m.user_id
      ${whereSql.length ? `WHERE ${whereSql.join(' AND ')}` : ''}
      ORDER BY COALESCE(m.sent_at, m.scheduled_for, m.created_at) DESC
      LIMIT $${vals.length}`,
    vals,
  );
  return res.rows.map((r) => ({ ...publicMessage(toMessage(r)), clientName: r.client_name, repId: r.user_id, repName: r.rep_name }));
}

/** Numbers that asked to stop, and which reps' clients they belong to. */
export async function optOuts(): Promise<KwOptOut[]> {
  const res = await query<{ phone_norm: string; source: string; created_at: Date; clients: { name: string; repName: string }[] | null }>(
    `SELECT o.phone_norm, o.source, o.created_at,
            json_agg(json_build_object('name', c.name, 'repName', COALESCE(NULLIF(p.display_name, ''), NULLIF(u.name, ''), u.email)))
              FILTER (WHERE c.id IS NOT NULL) AS clients
       FROM kw_optouts o
       LEFT JOIN kw_clients c ON c.phone_norm = o.phone_norm
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN kw_profiles p ON p.user_id = c.user_id
      GROUP BY o.phone_norm, o.source, o.created_at
      ORDER BY o.created_at DESC`,
  );
  return res.rows.map((r) => ({ phone: r.phone_norm, source: r.source, createdAt: r.created_at.toISOString(), clients: r.clients ?? [] }));
}
