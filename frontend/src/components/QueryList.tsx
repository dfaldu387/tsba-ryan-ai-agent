import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AUDIENCE_LABELS,
  AUTOMATED_RESPONSE_PREFIX,
  CHANNEL_LABELS,
  OUTCOME_LABELS,
  type Audience,
  type Channel,
  type DraftAction,
  type DraftStatus,
  type Outcome,
  type SourceCard,
} from '@tsba/shared';
import {
  ApiError,
  AuthError,
  draftGmailQuery,
  getGmailQueries,
  listDrafts,
  patchDraft,
  replyGmailQuery,
} from '../api';
import { Chip, EmptyState, ErrorState, Icon, Pill, RelTime, SearchInput, SkeletonRows, Trunc, type Tone } from '../ui';
import { fmtAbs, mask } from '../lib/format';
import { useConsole } from '../lib/console';
import './inbox.css';

// ─── Support inbox ────────────────────────────────────────────────────────────
// Two panes: the thread list (Gmail inbox when connected, in-app queries
// otherwise) and the selected thread with the agent's drafted reply. Selecting a
// Gmail thread drafts a grounded reply; the operator reviews, edits and sends it.

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
  editing?: boolean;
  sending?: boolean;
  sent?: boolean;
  sendError?: string;
  acting?: boolean;
  actError?: string;
}

type SortKey = 'newest' | 'oldest' | 'from' | 'subject';
type DateFilter = 'all' | 'today' | '7d' | '30d';

interface Status { key: string; label: string; tone: Tone }

const DRAFT_STATUS: Record<DraftStatus, Status> = {
  pending: { key: 'pending', label: 'Awaiting review', tone: 'warning' },
  sent: { key: 'sent', label: 'Sent', tone: 'success' },
  team: { key: 'team', label: 'To team', tone: 'info' },
  rejected: { key: 'rejected', label: 'Rejected', tone: 'danger' },
};
const STATUS_ORDER = ['new', 'pending', 'drafted', 'replied', 'sent', 'team', 'rejected'];
const AUDIENCES: Audience[] = ['customer', 'installer', 'sales'];
const DATE_FILTERS: { key: DateFilter; label: string }[] = [
  { key: 'all', label: 'Any time' },
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
];
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'from', label: 'Sender A–Z' },
  { key: 'subject', label: 'Subject A–Z' },
];

const OUTCOME_TONE: Record<Outcome, Tone> = { answer: 'success', clarify: 'info', handover: 'warning', decline: 'neutral' };
const REVIEW_OUTCOMES: Outcome[] = ['clarify', 'handover', 'decline'];

// Heuristic safety flags: keyword match over the question + drafted reply.
const SAFETY_FLAGS: { label: string; tone: Tone; re: RegExp }[] = [
  { label: 'Battery', tone: 'warning', re: /\bbatter(y|ies)\b|\bbms\b|lithium|lifepo4?|\bess\b/i },
  { label: 'AS/NZS 5139', tone: 'warning', re: /as\s*\/?\s*nzs\s*5139|\b5139\b/i },
  { label: 'Electrical', tone: 'warning', re: /electric|voltage|wiring|\bshock|\barc(ing)?\b|\bdc\b|\bac\b|earth(ing)? fault|\brcd\b/i },
  { label: 'Isolation', tone: 'warning', re: /isolat/i },
  { label: 'Fire', tone: 'danger', re: /\bfire\b|smoke|burn(t|ing|ed)?\b|melt|overheat|scorch/i },
];

// Quick replies for "Needs more info" drafts — pre-fill the editor.
const QUICK_REPLIES: { label: string; body: string }[] = [
  {
    label: 'Ask for model number',
    body: 'Thanks for getting in touch. So we can look into this for you, could you please send us the exact model number of the inverter or battery? It is printed on the rating label on the side of the unit.',
  },
  {
    label: 'Ask for serial number',
    body: 'Thanks for getting in touch. Could you please send us the serial number of the unit? You will find it on the rating label on the side of the inverter or battery, or in the monitoring app under device information.',
  },
  {
    label: 'Ask for a photo of the fault screen',
    body: 'Thanks for getting in touch. Could you please send us a clear photo of the inverter display showing the fault or error code? If it is safe to do so, a photo of the rating label would also help us identify the exact model.',
  },
];

function fromName(from: string): string { const m = from.match(/^\s*"?([^"<]+?)"?\s*</); return (m ? m[1] : from.replace(/<[^>]+>/, '')).trim() || from; }
function initials(name: string): string { const p = name.trim().split(/\s+/).filter(Boolean); if (!p.length) return '?'; if (p.length === 1) return p[0].slice(0, 2).toUpperCase(); return (p[0][0] + p[p.length - 1][0]).toUpperCase(); }
function replyBody(reply: string): string { const r = reply.trimStart(); return r.startsWith(AUTOMATED_RESPONSE_PREFIX) ? r.slice(AUTOMATED_RESPONSE_PREFIX.length).trim() : r; }
function withPrefix(body: string): string { return `${AUTOMATED_RESPONSE_PREFIX} ${body}`; }
function inRange(iso: string, f: DateFilter): boolean {
  if (f === 'all') return true;
  const t = new Date(iso).getTime(); if (Number.isNaN(t)) return false;
  const day = 86400000;
  if (f === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return t >= d.getTime(); }
  if (f === '7d') return t >= Date.now() - 7 * day;
  return t >= Date.now() - 30 * day;
}

/** Narrow layout (< 960px): list and detail become separate full-width views. */
function useNarrow(): boolean {
  const q = '(max-width: 959px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function QueryList({ onAuthError }: { onAuthError: () => void }) {
  const { canSeePii, toast, navigate, upsertDraft } = useConsole();
  const narrow = useNarrow();

  const [rows, setRows] = useState<QueryRow[]>([]);
  const [mode, setMode] = useState<'gmail' | 'draft'>('gmail');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | Audience>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [sort, setSort] = useState<SortKey>('newest');
  const [selected, setSelected] = useState<string | null>(null);
  const [byId, setById] = useState<Record<string, DraftState>>({});
  const listRef = useRef<HTMLUListElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const requested = useRef<Set<string>>(new Set());
  const authRef = useRef(onAuthError);
  authRef.current = onAuthError;

  const patch = useCallback((id: string, p: Partial<DraftState>) => setById((prev) => ({ ...prev, [id]: { ...prev[id], ...p } })), []);

  async function load() {
    setLoading(true); setError('');
    requested.current.clear();
    try {
      const { queries } = await getGmailQueries('INBOX', 50);
      setMode('gmail'); setById({});
      setRows(queries.map((q) => ({ id: q.id, kind: 'gmail' as const, from: q.from, subject: q.subject, snippet: q.snippet, date: q.date, webUrl: q.webUrl })));
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      try {
        const drafts = await listDrafts();
        setMode('draft');
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

  function rowStatus(row: QueryRow): Status {
    if (row.kind === 'draft') return DRAFT_STATUS[row.draftStatus ?? 'pending'];
    const d = byId[row.id];
    if (d?.sent) return { key: 'replied', label: 'Replied', tone: 'success' };
    if (d && d.text != null && !d.error && !d.loading) return { key: 'drafted', label: 'Drafted', tone: 'neutral' };
    return { key: 'new', label: 'New', tone: 'info' };
  }

  const senderLabel = (r: QueryRow) => {
    const name = fromName(r.from);
    return r.kind === 'gmail' && !canSeePii ? mask(name) : name;
  };

  const hasSource = useMemo(() => rows.some((r) => r.audience), [rows]);

  // search + source + date, then sort. (Status filter applied after, so chips show full counts.)
  const preStatus = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = rows.filter((m) => {
      if (q && !(m.subject.toLowerCase().includes(q) || (canSeePii && m.from.toLowerCase().includes(q)) || m.snippet.toLowerCase().includes(q))) return false;
      if (sourceFilter !== 'all' && m.audience !== sourceFilter) return false;
      if (!inRange(m.date, dateFilter)) return false;
      return true;
    });
    return [...base].sort((a, b) => {
      if (sort === 'from') return fromName(a.from).localeCompare(fromName(b.from));
      if (sort === 'subject') return a.subject.localeCompare(b.subject);
      const cmp = new Date(a.date).getTime() - new Date(b.date).getTime();
      return sort === 'oldest' ? cmp : -cmp;
    });
  }, [rows, search, sourceFilter, dateFilter, sort, canSeePii]);

  const chips = useMemo(() => {
    const counts = new Map<string, Status & { count: number }>();
    for (const r of preStatus) {
      const s = rowStatus(r);
      const cur = counts.get(s.key);
      if (cur) cur.count++; else counts.set(s.key, { ...s, count: 1 });
    }
    return [...counts.values()].sort((a, b) => STATUS_ORDER.indexOf(a.key) - STATUS_ORDER.indexOf(b.key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preStatus, byId]);

  const visible = useMemo(
    () => (statusFilter === 'all' ? preStatus : preStatus.filter((r) => rowStatus(r).key === statusFilter)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preStatus, statusFilter, byId],
  );

  const filtersActive = search.trim() !== '' || statusFilter !== 'all' || sourceFilter !== 'all' || dateFilter !== 'all';
  function resetFilters() { setSearch(''); setStatusFilter('all'); setSourceFilter('all'); setDateFilter('all'); }

  const current = rows.find((r) => r.id === selected) ?? null;

  // ── Drafting ──────────────────────────────────────────────────────────────
  const generate = useCallback(async (id: string) => {
    requested.current.add(id);
    setById((p) => ({ ...p, [id]: { ...p[id], loading: true, error: undefined, editing: false, sendError: undefined } }));
    try {
      const d = await draftGmailQuery(id);
      setById((p) => ({ ...p, [id]: { ...p[id], loading: false, audience: d.audience, channel: d.channel, outcome: d.result.outcome, sources: d.sources, text: d.result.reply } }));
    } catch (err) {
      if (err instanceof AuthError) return authRef.current();
      setById((p) => ({ ...p, [id]: { ...p[id], loading: false, error: 'Couldn’t draft a reply. Try again.' } }));
    }
  }, []);

  // Draft the selected Gmail thread once the selection settles (so arrowing
  // through the list doesn't fire a draft request for every thread passed).
  useEffect(() => {
    if (!current || current.kind !== 'gmail' || requested.current.has(current.id)) return;
    const t = window.setTimeout(() => void generate(current.id), 350);
    return () => window.clearTimeout(t);
  }, [current, generate]);

  function select(id: string, focusDetail = false) {
    setSelected(id);
    if (focusDetail && narrow) window.setTimeout(() => detailRef.current?.focus(), 0);
  }

  function back() {
    const id = selected;
    setSelected(null);
    window.setTimeout(() => listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id ?? '')}"]`)?.focus(), 0);
  }

  function onListKey(e: React.KeyboardEvent<HTMLUListElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(e.key) || !visible.length) return;
    e.preventDefault();
    const idx = visible.findIndex((r) => r.id === selected);
    if (e.key === 'Enter' || e.key === ' ') {
      if (idx >= 0) select(visible[idx].id, true);
      else select(visible[0].id, true);
      return;
    }
    let next = idx;
    if (e.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(visible.length - 1, idx + 1);
    else if (e.key === 'ArrowUp') next = idx < 0 ? 0 : Math.max(0, idx - 1);
    else if (e.key === 'Home') next = 0;
    else next = visible.length - 1;
    const id = visible[next].id;
    // On narrow screens arrows only move focus — opening is an explicit Enter/tap.
    if (narrow) { listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus(); return; }
    setSelected(id);
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
  }

  async function act(id: string, action: DraftAction) {
    patch(id, { acting: true, actError: undefined });
    try {
      const updated = await patchDraft(Number(id), action);
      upsertDraft(updated);
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, draftStatus: updated.status, snippet: replyBody(updated.reply).slice(0, 150) } : r)));
      patch(id, { acting: false, editing: false, text: updated.reply, outcome: updated.outcome });
      const msg = action.action === 'approve' ? 'Reply approved and sent.' : action.action === 'reject' ? 'Query rejected.' : 'Edit saved.';
      toast({ text: msg, tone: 'success' });
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      patch(id, { acting: false, actError: 'Couldn’t update this query. Try again.' });
    }
  }

  async function send(id: string) {
    const d = byId[id];
    if (!d?.text?.trim()) return;
    patch(id, { sending: true, sendError: undefined });
    try {
      await replyGmailQuery(id, d.text);
      patch(id, { sending: false, sent: true, editing: false });
      toast({ text: 'Reply sent to the Gmail thread.', tone: 'success' });
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      const msg = err instanceof ApiError && err.code === 'gmail_not_connected' ? 'Gmail disconnected — reconnect it to send.' : 'Couldn’t send the reply. Try again.';
      patch(id, { sending: false, sendError: msg });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const view = narrow && current ? 'detail' : 'list';

  return (
    <div className="ib" data-view={view}>
      {/* ── Thread list ─────────────────────────────────────────────────── */}
      <div className="ib-list">
        <div className="ib-list-h">
          <div className="ib-list-title">
            <h2>{mode === 'gmail' ? 'Gmail inbox' : 'End-user queries'}</h2>
            {!loading && !error && <span className="ib-count">{visible.length} of {rows.length}</span>}
            <button type="button" className="c-iconbtn" onClick={() => void load()} disabled={loading} title="Refresh" aria-label="Refresh inbox">
              <Icon name="refresh" size={16} />
            </button>
          </div>
          {mode === 'draft' && !loading && (
            <div className="c-banner t-info" role="status" style={{ padding: '8px 10px', fontSize: 12.5 }}>
              <span className="c-grow">Gmail isn’t connected — showing in-app queries.</span>
              <button type="button" className="c-link" onClick={() => navigate('connections')}>Connect</button>
            </div>
          )}
          {!loading && !error && rows.length > 0 && (
            <>
              <SearchInput value={search} onChange={setSearch} placeholder={canSeePii ? 'Search sender, subject or text…' : 'Search subject or text…'} label="Search threads" />
              <div className="ib-chips" role="group" aria-label="Filter by status">
                <Chip active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} count={preStatus.length}>All</Chip>
                {chips.map((c) => (
                  <Chip key={c.key} tone={c.tone} active={statusFilter === c.key} count={c.count} onClick={() => setStatusFilter(statusFilter === c.key ? 'all' : c.key)}>
                    {c.label}
                  </Chip>
                ))}
              </div>
              <div className="ib-filters">
                {hasSource && (
                  <select className="c-select" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as 'all' | Audience)} aria-label="Filter by source">
                    <option value="all">All sources</option>
                    {AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABELS[a]}</option>)}
                  </select>
                )}
                <select className="c-select" value={dateFilter} onChange={(e) => setDateFilter(e.target.value as DateFilter)} aria-label="Filter by date">
                  {DATE_FILTERS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
                <select className="c-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort threads">
                  {SORTS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
                {filtersActive && <button type="button" className="c-btn sm ghost" onClick={resetFilters}>Clear</button>}
              </div>
            </>
          )}
        </div>

        {loading ? (
          <SkeletonRows rows={7} cols={2} />
        ) : error ? (
          <div className="ib-list-state"><ErrorState title="Couldn’t load the inbox" detail={error} onRetry={() => void load()} /></div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="inbox"
            title={rows.length === 0 ? 'No queries yet' : 'No threads match your filters'}
            hint={rows.length === 0 ? 'New support emails will appear here.' : undefined}
            action={rows.length > 0 ? <button type="button" className="c-btn" onClick={resetFilters}>Clear filters</button> : undefined}
          />
        ) : (
          <ul
            ref={listRef}
            className="ib-threads"
            role="listbox"
            aria-label="Threads"
            tabIndex={-1}
            onKeyDown={onListKey}
          >
            {visible.map((m, i) => {
              const st = rowStatus(m);
              const isSel = m.id === selected;
              const tabbable = selected ? isSel || (!visible.some((r) => r.id === selected) && i === 0) : i === 0;
              return (
                <li
                  key={m.id}
                  data-id={m.id}
                  role="option"
                  aria-selected={isSel}
                  tabIndex={tabbable ? 0 : -1}
                  className={`ib-thread ${st.key === 'new' ? 'is-new' : ''}`}
                  onClick={() => select(m.id, true)}
                >
                  <span className="ib-avatar" aria-hidden="true">{initials(senderLabel(m).replace(/•/g, ''))}</span>
                  <span className="ib-thread-top">
                    <Trunc text={senderLabel(m)} className="ib-from" />
                    <span className="ib-date"><RelTime t={m.date} /></span>
                  </span>
                  <Trunc text={m.subject || '(no subject)'} className="ib-subj" />
                  {m.snippet && <Trunc text={m.snippet} className="ib-snip" />}
                  <span className="ib-thread-foot" style={{ gridColumn: 2 }}>
                    <Pill tone={st.tone} dot>{st.label}</Pill>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── Thread + draft ──────────────────────────────────────────────── */}
      <div className="ib-detail" ref={detailRef} tabIndex={-1} aria-label="Selected thread">
        {!current ? (
          <div className="ib-detail-empty">
            <EmptyState icon="mail" title="Select a thread" hint="Choose a message on the left to read it and review the agent’s drafted reply. Use ↑ and ↓ to move through the list." />
          </div>
        ) : (
          <ThreadDetail
            row={current}
            sender={senderLabel(current)}
            status={rowStatus(current)}
            d={byId[current.id]}
            onBack={back}
            onText={(text) => patch(current.id, { text })}
            onEditing={(editing) => patch(current.id, { editing })}
            onRegenerate={() => void generate(current.id)}
            onSend={() => void send(current.id)}
            onAct={(a) => void act(current.id, a)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Detail pane ──────────────────────────────────────────────────────────────
function ThreadDetail({
  row, sender, status, d, onBack, onText, onEditing, onRegenerate, onSend, onAct,
}: {
  row: QueryRow;
  sender: string;
  status: Status;
  d: DraftState | undefined;
  onBack: () => void;
  onText: (text: string) => void;
  onEditing: (editing: boolean) => void;
  onRegenerate: () => void;
  onSend: () => void;
  onAct: (a: DraftAction) => void;
}) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const editing = !!d?.editing;
  useEffect(() => { if (editing) editorRef.current?.focus(); }, [editing]);

  const body = replyBody(d?.text ?? '');
  const hasDraft = !!d && !d.loading && !d.error && d.text != null;
  const reviewRequired = hasDraft && ((d!.outcome && REVIEW_OUTCOMES.includes(d!.outcome)) || !d!.sources?.length);
  const haystack = `${row.subject}\n${row.snippet}\n${body}`;
  const flags = SAFETY_FLAGS.filter((f) => f.re.test(haystack));
  const finished = row.kind === 'gmail' ? !!d?.sent : row.draftStatus !== 'pending';
  const busy = !!(d?.sending || d?.acting);

  const reviewReason = !hasDraft ? '' :
    d!.outcome === 'clarify' ? 'The agent needs more information before it can answer.' :
    d!.outcome === 'handover' ? 'The agent handed this to the team — check the reply before sending.' :
    d!.outcome === 'decline' ? 'The agent declined to answer — confirm this is appropriate.' :
    'The reply isn’t grounded in any knowledge-base source.';

  return (
    <>
      <header className="ib-thread-h">
        <div className="ib-thread-h-row ib-back-row">
          <button type="button" className="c-btn sm ghost ib-back" onClick={onBack}>
            <Icon name="chevron" size={16} className="ib-back-ico" /> Back to inbox
          </button>
        </div>
        <div className="ib-thread-h-row">
          <h2>{row.subject || '(no subject)'}</h2>
          {row.webUrl && (
            <a className="c-btn sm" href={row.webUrl} target="_blank" rel="noreferrer noopener">
              <Icon name="external" size={15} /> Open in Gmail
            </a>
          )}
        </div>
        <div className="ib-thread-meta">
          <span>From <strong>{sender}</strong></span>
          <span aria-hidden="true">·</span>
          <time dateTime={row.date} title={fmtAbs(row.date)}>{fmtAbs(row.date)}</time>
          <Pill tone={status.tone} dot>{status.label}</Pill>
        </div>
      </header>

      <div className="ib-body">
        {row.kind === 'gmail' && row.snippet && (
          <div className="ib-msg">
            <span className="ib-msg-k">Message preview</span>
            {row.snippet}
          </div>
        )}
        {row.kind === 'draft' && (
          <div className="ib-msg">
            <span className="ib-msg-k">Question received</span>
            {row.subject}
          </div>
        )}

        <section className="ib-draft" aria-labelledby="ib-draft-h">
          <div className="ib-draft-h">
            <h3 id="ib-draft-h"><Icon name="ai" size={16} /> AI draft</h3>
            {hasDraft && d!.audience && <span className="ib-tag" title="Detected audience">{AUDIENCE_LABELS[d!.audience]}</span>}
            {hasDraft && d!.channel && <span className="ib-tag" title="Channel">{CHANNEL_LABELS[d!.channel]}</span>}
            {hasDraft && d!.outcome && <Pill tone={OUTCOME_TONE[d!.outcome]} dot>{OUTCOME_LABELS[d!.outcome][0]}</Pill>}
          </div>

          <div aria-live="polite" aria-busy={!!d?.loading}>
            {!d || d.loading ? (
              <div className="ib-loading">
                <p>Reading the message and drafting a grounded reply…</p>
                <span className="c-skel" /><span className="c-skel" /><span className="c-skel" />
              </div>
            ) : d.error ? (
              <div className="ib-draft-b">
                <ErrorState title="Couldn’t draft a reply" detail={d.error} onRetry={row.kind === 'gmail' ? onRegenerate : undefined} />
              </div>
            ) : (
              <div className="ib-draft-b">
                {reviewRequired && (
                  <div className="c-banner t-warning" role="note">
                    <Icon name="alert" />
                    <span><strong>Human review required.</strong> {reviewReason}</span>
                  </div>
                )}

                {flags.length > 0 && (
                  <div className="ib-safety" aria-label="Safety flags">
                    <Icon name="shield" size={14} />
                    <span>Safety:</span>
                    {flags.map((f) => <Pill key={f.label} tone={f.tone} title="Keyword match — check the reply follows safety guidance">{f.label}</Pill>)}
                  </div>
                )}

                <div className="ib-reply">
                  <span className="ib-reply-prefix">{AUTOMATED_RESPONSE_PREFIX}</span>
                  {editing ? (
                    <textarea
                      ref={editorRef}
                      value={body}
                      onChange={(e) => onText(withPrefix(e.target.value))}
                      aria-label="Edit reply"
                      rows={8}
                    />
                  ) : (
                    <div className="ib-reply-text">{body || <span className="c-muted">No reply drafted.</span>}</div>
                  )}
                </div>

                {d.outcome === 'clarify' && !finished && (
                  <div className="ib-quick">
                    <span className="ib-quick-k">Quick replies — pre-fill the editor</span>
                    <div className="ib-quick-row">
                      {QUICK_REPLIES.map((q) => (
                        <button key={q.label} type="button" className="c-btn sm" onClick={() => { onText(withPrefix(q.body)); onEditing(true); }}>
                          {q.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {d.sources && d.sources.length > 0 && (
                  <details className="ib-sources">
                    <summary><Icon name="chevron" size={14} /> Sources ({d.sources.length})</summary>
                    <ul>
                      {d.sources.map((s) => (
                        <li key={s.id}>
                          <Trunc text={s.title} />
                          <span>{s.source}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>

          {hasDraft && (
            <div className="ib-actions">
              {row.kind === 'gmail' ? (
                d!.sent ? (
                  <span className="ib-sent"><Icon name="check" size={16} /> Sent to the thread in Gmail</span>
                ) : (
                  <>
                    <button type="button" className="c-btn primary" onClick={onSend} disabled={busy || !body.trim()}>
                      <Icon name="send" size={15} /> {d!.sending ? 'Sending…' : 'Approve & send'}
                    </button>
                    <button type="button" className="c-btn" onClick={() => onEditing(!editing)} disabled={busy} aria-pressed={editing}>
                      <Icon name="drafts" size={15} /> {editing ? 'Done editing' : 'Edit'}
                    </button>
                    <button type="button" className="c-btn ghost" onClick={onRegenerate} disabled={busy}>
                      <Icon name="refresh" size={15} /> Regenerate
                    </button>
                  </>
                )
              ) : (
                <>
                  <button type="button" className="c-btn primary" onClick={() => onAct({ action: 'approve', text: d!.text })} disabled={busy || finished}>
                    <Icon name="send" size={15} /> {d!.acting ? 'Working…' : 'Approve & send'}
                  </button>
                  {editing ? (
                    <button type="button" className="c-btn" onClick={() => onAct({ action: 'edit', text: d!.text ?? '' })} disabled={busy}>
                      <Icon name="check" size={15} /> Save edit
                    </button>
                  ) : (
                    <button type="button" className="c-btn" onClick={() => onEditing(true)} disabled={busy}>
                      <Icon name="drafts" size={15} /> Edit
                    </button>
                  )}
                  <button type="button" className="c-btn ghost danger" onClick={() => onAct({ action: 'reject' })} disabled={busy || finished}>
                    <Icon name="x" size={15} /> Reject
                  </button>
                </>
              )}
              <span className="c-spacer" />
              {row.webUrl && (
                <a className="c-btn sm ghost" href={row.webUrl} target="_blank" rel="noreferrer noopener">
                  Open in Gmail <Icon name="external" size={14} />
                </a>
              )}
              {d!.sendError && <span className="c-row" role="alert" style={{ color: 'var(--danger)', fontSize: 13 }}>{d!.sendError}</span>}
              {d!.actError && <span className="c-row" role="alert" style={{ color: 'var(--danger)', fontSize: 13 }}>{d!.actError}</span>}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
