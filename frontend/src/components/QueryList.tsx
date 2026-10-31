import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AUDIENCE_LABELS,
  AUTOMATED_RESPONSE_PREFIX,
  CHANNEL_LABELS,
  OUTCOME_LABELS,
  type Audience,
  type Channel,
  type DraftStatus,
  type Outcome,
  type SourceCard,
} from '@tsba/shared';
import type { DraftAction } from '@tsba/shared';
import {
  ApiError,
  AuthError,
  draftGmailQuery,
  getGmailQueries,
  listDrafts,
  patchDraft,
  replyGmailQuery,
} from '../api';

// ─── Support inbox (Ask the agent) ────────────────────────────────────────────
// A support-inbox table of end-user queries. Fed from Gmail when connected
// (expand → auto-draft → send a reply to the thread), and from the in-app
// queries (drafts) otherwise. KPI stat cards sit above the panel; the panel has
// search + status / source / date-range filters over the table.

type RowKind = 'gmail' | 'draft';

interface QueryRow {
  id: string;
  kind: RowKind;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  webUrl?: string;
  draftStatus?: DraftStatus;
  audience?: Audience; // the detected source (who asked) for in-app rows
}

interface DraftState {
  loading?: boolean;
  error?: string;
  audience?: Audience;
  channel?: Channel;
  outcome?: Outcome;
  sources?: SourceCard[];
  text?: string;
  sending?: boolean;
  sent?: boolean;
  sendError?: string;
  acting?: boolean;
  actError?: string;
}

type SortKey = 'from' | 'subject' | 'date';
type SortDir = 'asc' | 'desc';
type DateFilter = 'all' | 'today' | '7d' | '30d';
const PAGE_SIZE = 8;

interface Status { key: string; label: string; cls: string }

const DRAFT_STATUS: Record<DraftStatus, Status> = {
  pending: { key: 'pending', label: 'Awaiting review', cls: 'warn' },
  sent: { key: 'sent', label: 'Sent', cls: 'ok' },
  team: { key: 'team', label: 'To team', cls: 'info' },
  rejected: { key: 'rejected', label: 'Rejected', cls: 'bad' },
};
const STATUS_ORDER = ['new', 'pending', 'drafted', 'replied', 'sent', 'team', 'rejected'];
const AUDIENCES: Audience[] = ['customer', 'installer', 'sales'];
const DATE_FILTERS: { key: DateFilter; label: string }[] = [
  { key: 'all', label: 'Any time' },
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
];

const AVATAR_COLORS = ['#e08b1b', '#6366f1', '#0ea5e9', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6', '#ef4444'];
function hashIdx(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % AVATAR_COLORS.length; }
function fromName(from: string): string { const m = from.match(/^\s*"?([^"<]+?)"?\s*</); return (m ? m[1] : from.replace(/<[^>]+>/, '')).trim() || from; }
function initials(name: string): string { const p = name.trim().split(/\s+/).filter(Boolean); if (!p.length) return '?'; if (p.length === 1) return p[0].slice(0, 2).toUpperCase(); return (p[0][0] + p[p.length - 1][0]).toUpperCase(); }
function whenShort(iso: string): string {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return iso;
  const now = new Date(); const yday = new Date(now); yday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === yday.toDateString()) return `Yesterday ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function replyBody(reply: string): string { const r = reply.trimStart(); return r.startsWith(AUTOMATED_RESPONSE_PREFIX) ? r.slice(AUTOMATED_RESPONSE_PREFIX.length).trim() : r; }
function inRange(iso: string, f: DateFilter): boolean {
  if (f === 'all') return true;
  const t = new Date(iso).getTime(); if (Number.isNaN(t)) return false;
  const day = 86400000;
  if (f === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return t >= d.getTime(); }
  if (f === '7d') return t >= Date.now() - 7 * day;
  return t >= Date.now() - 30 * day;
}

export function QueryList({ onAuthError }: { onAuthError: () => void }) {
  const [rows, setRows] = useState<QueryRow[]>([]);
  const [mode, setMode] = useState<'gmail' | 'draft'>('gmail');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | Audience>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [byId, setById] = useState<Record<string, DraftState>>({});
  const [toast, setToast] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError('');
    try {
      const { queries } = await getGmailQueries('INBOX', 50);
      setMode('gmail'); setById({});
      setRows(queries.map((q) => ({ id: q.id, kind: 'gmail' as const, from: q.from, subject: q.subject, snippet: q.snippet, date: q.date, webUrl: q.webUrl })));
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      try {
        const drafts = await listDrafts();
        setMode('draft');
        setToast('Gmail isn’t connected — showing in-app queries. Connect Gmail in Connections to pull your live inbox and send replies.');
        const prefill: Record<string, DraftState> = {};
        for (const d of drafts) prefill[String(d.id)] = { audience: d.audience, channel: d.channel, outcome: d.outcome, sources: d.sources, text: d.reply };
        setById(prefill);
        setRows(drafts.map((d) => ({ id: String(d.id), kind: 'draft' as const, from: AUDIENCE_LABELS[d.audience], subject: d.question, snippet: replyBody(d.reply).slice(0, 150), date: d.created_at, draftStatus: d.status, audience: d.audience })));
      } catch (err2) {
        if (err2 instanceof AuthError) return onAuthError();
        setError('Couldn’t load queries. Try again.');
      }
    } finally { setLoading(false); }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), []);

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 7000);
    return () => window.clearTimeout(t);
  }, [toast]);

  function rowStatus(row: QueryRow): Status {
    if (row.kind === 'draft') return DRAFT_STATUS[row.draftStatus ?? 'pending'];
    const d = byId[row.id];
    if (d?.sent) return { key: 'replied', label: 'Replied', cls: 'ok' };
    if (d && !d.error && !d.loading) return { key: 'drafted', label: 'Drafted', cls: 'info' };
    return { key: 'new', label: 'New', cls: 'accent' };
  }

  const hasSource = useMemo(() => rows.some((r) => r.audience), [rows]);

  // search + source + date, then sort. (Status filter applied after, so tiles show full counts.)
  const preStatus = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = rows.filter((m) => {
      if (q && !(m.subject.toLowerCase().includes(q) || m.from.toLowerCase().includes(q) || m.snippet.toLowerCase().includes(q))) return false;
      if (sourceFilter !== 'all' && m.audience !== sourceFilter) return false;
      if (!inRange(m.date, dateFilter)) return false;
      return true;
    });
    return [...base].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'date') cmp = new Date(a.date).getTime() - new Date(b.date).getTime();
      else if (sortKey === 'from') cmp = fromName(a.from).localeCompare(fromName(b.from));
      else cmp = a.subject.localeCompare(b.subject);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rows, search, sourceFilter, dateFilter, sortKey, sortDir]);

  const tiles = useMemo(() => {
    const counts = new Map<string, Status & { count: number }>();
    for (const r of preStatus) {
      const s = rowStatus(r);
      const cur = counts.get(s.key);
      if (cur) cur.count++; else counts.set(s.key, { ...s, count: 1 });
    }
    const ordered = [...counts.values()].sort((a, b) => STATUS_ORDER.indexOf(a.key) - STATUS_ORDER.indexOf(b.key));
    return [{ key: 'all', label: 'All', cls: 'all', count: preStatus.length }, ...ordered];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preStatus, byId]);

  const statusOptions = useMemo(() => tiles.map((t) => ({ key: t.key, label: t.key === 'all' ? 'All statuses' : t.label })), [tiles]);

  const visible = useMemo(
    () => (statusFilter === 'all' ? preStatus : preStatus.filter((r) => rowStatus(r).key === statusFilter)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preStatus, statusFilter, byId],
  );

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const start = (pageSafe - 1) * PAGE_SIZE;
  const pageRows = visible.slice(start, start + PAGE_SIZE);

  const filtersActive = search.trim() !== '' || statusFilter !== 'all' || sourceFilter !== 'all' || dateFilter !== 'all';
  function resetFilters() { setSearch(''); setStatusFilter('all'); setSourceFilter('all'); setDateFilter('all'); setPage(1); }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'date' ? 'desc' : 'asc'); }
  }
  const sortMark = (key: SortKey) => (sortKey !== key ? '↕' : sortDir === 'asc' ? '↑' : '↓');

  async function expand(row: QueryRow) {
    if (expanded === row.id) { setExpanded(null); return; }
    setExpanded(row.id);
    if (row.kind === 'draft' || byId[row.id]) return;
    setById((p) => ({ ...p, [row.id]: { loading: true } }));
    try {
      const d = await draftGmailQuery(row.id);
      setById((p) => ({ ...p, [row.id]: { audience: d.audience, channel: d.channel, outcome: d.result.outcome, sources: d.sources, text: d.result.reply } }));
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      setById((p) => ({ ...p, [row.id]: { error: 'Couldn’t draft a reply. Try again.' } }));
    }
  }

  async function act(id: string, action: DraftAction) {
    setById((p) => ({ ...p, [id]: { ...p[id], acting: true, actError: undefined } }));
    try {
      const updated = await patchDraft(Number(id), action);
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, draftStatus: updated.status, snippet: replyBody(updated.reply).slice(0, 150) } : r)));
      setById((p) => ({ ...p, [id]: { ...p[id], acting: false, text: updated.reply, outcome: updated.outcome } }));
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      setById((p) => ({ ...p, [id]: { ...p[id], acting: false, actError: 'Couldn’t update this query. Try again.' } }));
    }
  }

  async function send(id: string) {
    const d = byId[id];
    if (!d?.text?.trim()) return;
    setById((p) => ({ ...p, [id]: { ...p[id], sending: true, sendError: undefined } }));
    try {
      await replyGmailQuery(id, d.text);
      setById((p) => ({ ...p, [id]: { ...p[id], sending: false, sent: true } }));
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      const msg = err instanceof ApiError && err.code === 'gmail_not_connected' ? 'Gmail disconnected — reconnect it to send.' : 'Couldn’t send the reply. Try again.';
      setById((p) => ({ ...p, [id]: { ...p[id], sending: false, sendError: msg } }));
    }
  }

  const showControls = !loading && !error && rows.length > 0;

  return (
    <div className="ql">
      {/* KPI stat cards — OUTSIDE the panel */}
      {showControls && (
        <div className="ql-stats">
          {tiles.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`ql-stat ${t.cls} ${statusFilter === t.key ? 'on' : ''}`}
              onClick={() => { setStatusFilter(t.key); setPage(1); }}
            >
              <span className="ql-stat-count">{t.count}</span>
              <span className="ql-stat-label"><span className="ql-stat-dot" aria-hidden="true" />{t.label}</span>
            </button>
          ))}
        </div>
      )}

      <section className="ql-panel">
        {/* Toolbar: title + filters */}
        <header className="ql-toolbar">
          <div className="ql-toolbar-title">
            <h2>{mode === 'gmail' ? 'Gmail inbox' : 'End-user queries'}</h2>
            <span className="ql-sub">{visible.length} of {rows.length} shown</span>
          </div>
          {showControls && (
            <div className="ql-filters">
              <input className="ql-search" type="text" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search sender or subject…" aria-label="Search" />

              <div className="ql-select-wrap">
                <select className="ql-select" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} aria-label="Filter by status">
                  {statusOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </div>

              {hasSource && (
                <div className="ql-select-wrap">
                  <select className="ql-select" value={sourceFilter} onChange={(e) => { setSourceFilter(e.target.value as 'all' | Audience); setPage(1); }} aria-label="Filter by source">
                    <option value="all">All sources</option>
                    {AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABELS[a]}</option>)}
                  </select>
                </div>
              )}

              <div className="ql-select-wrap">
                <select className="ql-select" value={dateFilter} onChange={(e) => { setDateFilter(e.target.value as DateFilter); setPage(1); }} aria-label="Filter by date">
                  {DATE_FILTERS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </div>

              {filtersActive && (
                <button type="button" className="ql-clear" onClick={resetFilters} title="Clear all filters">Clear</button>
              )}
              <button type="button" className="ql-icon-btn" onClick={() => void load()} disabled={loading} title="Refresh" aria-label="Refresh">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" />
                </svg>
              </button>
            </div>
          )}
        </header>

        {loading ? (
          <div className="ql-state thinking"><span className="spin" aria-hidden="true" /><span>Loading queries…</span></div>
        ) : error ? (
          <div className="ql-state"><p className="err" role="status">{error}</p></div>
        ) : visible.length === 0 ? (
          <div className="ql-state"><p className="empty">{rows.length === 0 ? 'No queries yet.' : 'No queries match your filters.'}</p></div>
        ) : (
          <>
            <div className="ql-table-wrap">
              <table className="ql-table">
                <thead>
                  <tr>
                    <th className="sortable ql-col-from" onClick={() => toggleSort('from')}>From <span className="ql-sort">{sortMark('from')}</span></th>
                    <th className="sortable" onClick={() => toggleSort('subject')}>Query <span className="ql-sort">{sortMark('subject')}</span></th>
                    <th className="sortable ql-col-date" onClick={() => toggleSort('date')}>Received <span className="ql-sort">{sortMark('date')}</span></th>
                    <th className="ql-col-status">Status</th>
                    <th aria-label="Expand" className="ql-col-x"></th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((m) => {
                    const isOpen = expanded === m.id;
                    const st = rowStatus(m);
                    const d = byId[m.id];
                    const name = fromName(m.from);
                    return (
                      <FragmentRow key={m.id}>
                        <tr className={`ql-trow ${isOpen ? 'open' : ''} ${st.key === 'new' ? 'is-new' : ''}`} onClick={() => void expand(m)}>
                          <td className="ql-td-from">
                            <span className="ql-avatar" style={{ background: AVATAR_COLORS[hashIdx(name)] }} aria-hidden="true">{initials(name)}</span>
                            <span className="ql-from-name">{name}</span>
                          </td>
                          <td className="ql-td-q">
                            <span className="ql-q-subj">{m.subject}</span>
                            {m.snippet && <span className="ql-q-snip">{m.snippet}</span>}
                          </td>
                          <td className="ql-col-date ql-td-date">{whenShort(m.date)}</td>
                          <td className="ql-col-status"><span className={`ql-status ${st.cls}`}><span className="ql-status-dot" aria-hidden="true" />{st.label}</span></td>
                          <td className="ql-col-x"><span className="ql-caret" aria-hidden="true">{isOpen ? '▴' : '▾'}</span></td>
                        </tr>
                        {isOpen && (
                          <tr className="ql-detail-row">
                            <td colSpan={5}>
                              <div className="ql-detail">
                                {!d || d.loading ? (
                                  <div className="ql-state thinking"><span className="spin" aria-hidden="true" /><span>Reading the message and drafting a grounded reply…</span></div>
                                ) : d.error ? (
                                  <p className="err" role="status">{d.error}</p>
                                ) : (
                                  <div className="ql-grid">
                                    <div className="ql-question">
                                      <span className="eyebrow">Question received</span>
                                      <p className="ql-question-subj">{m.subject}</p>
                                      {m.snippet && <p className="ql-question-snip">{m.snippet}</p>}
                                      <div className="ql-detail-tags">
                                        {d.audience && <span className="ql-chip">{AUDIENCE_LABELS[d.audience]}</span>}
                                        {d.channel && <span className="ql-chip soft">{CHANNEL_LABELS[d.channel]}</span>}
                                        {d.outcome && <span className={`ql-chip ${OUTCOME_LABELS[d.outcome][1]}`}>{OUTCOME_LABELS[d.outcome][0]}</span>}
                                        {m.webUrl && <a className="ql-open-mail" href={m.webUrl} target="_blank" rel="noreferrer">Open in Gmail ↗</a>}
                                      </div>
                                    </div>

                                    <div className="ql-reply-col">
                                      <span className="eyebrow">Agent’s drafted reply — edit before sending</span>
                                      <div className="ql-reply-shell">
                                        <span className="ql-reply-prefix">{AUTOMATED_RESPONSE_PREFIX}</span>
                                        <textarea className="ql-reply" value={replyBody(d.text ?? '')} onChange={(e) => setById((p) => ({ ...p, [m.id]: { ...p[m.id], text: `${AUTOMATED_RESPONSE_PREFIX} ${e.target.value}` } }))} rows={5} />
                                      </div>
                                      {d.sources && d.sources.length > 0 && (
                                        <div className="ql-sources">
                                          <span className="ql-sources-k">Grounded in</span>
                                          {d.sources.map((s) => <span key={s.id} className="ql-source-chip" title={s.source}>{s.title}</span>)}
                                        </div>
                                      )}
                                      <div className="ql-actions">
                                        {m.kind === 'gmail' ? (
                                          <button type="button" className="btn" onClick={() => void send(m.id)} disabled={d.sending || d.sent}>{d.sent ? '✓ Reply sent' : d.sending ? 'Sending…' : 'Send reply'}</button>
                                        ) : (
                                          <>
                                            <button type="button" className="btn" onClick={() => void act(m.id, { action: 'approve', text: d.text })} disabled={d.acting}>{d.acting ? 'Working…' : 'Approve & send'}</button>
                                            <button type="button" className="btn-ghost" onClick={() => void act(m.id, { action: 'edit', text: d.text ?? '' })} disabled={d.acting}>Save edit</button>
                                            <button type="button" className="btn-ghost danger" onClick={() => void act(m.id, { action: 'reject' })} disabled={d.acting}>Reject</button>
                                          </>
                                        )}
                                        {d.sent && <span className="ql-sent-note">✓ Sent to the thread in Gmail.</span>}
                                        {d.sendError && <span className="err" role="status">{d.sendError}</span>}
                                        {d.actError && <span className="err" role="status">{d.actError}</span>}
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </FragmentRow>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <footer className="ql-footer">
              <span className="ql-range">{start + 1}–{Math.min(start + PAGE_SIZE, visible.length)} of {visible.length}</span>
              {totalPages > 1 && (
                <div className="ql-pager">
                  <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={pageSafe === 1} aria-label="Previous page">←</button>
                  <span>Page {pageSafe} / {totalPages}</span>
                  <button type="button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={pageSafe === totalPages} aria-label="Next page">→</button>
                </div>
              )}
            </footer>
          </>
        )}
      </section>

      {toast && (
        <div className="ql-toast" role="status">
          <span className="ql-toast-ico" aria-hidden="true">✉</span>
          <span className="ql-toast-msg">{toast}</span>
          <button type="button" className="ql-toast-x" onClick={() => setToast(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
    </div>
  );
}

function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
