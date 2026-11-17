import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  hasPermission,
  type AuthenticatedUser,
  type DriveFolderSource,
  type GmailScanResult,
  type IngestedDocument,
} from '@tsba/shared';
import {
  ApiError,
  AuthError,
  assessDocuments,
  listConnections,
  listDocuments,
  listFolderSources,
  reingestFlaggedDocuments,
  removeDocument,
  removeFolderSource,
  resyncAll,
  syncAllFolderSources,
  syncFolderSource,
} from '../api';
import {
  Chip,
  Drawer,
  EmptyState,
  ErrorState,
  Icon,
  Menu,
  Pill,
  RelTime,
  SearchInput,
  Section,
  SkeletonRows,
  Trunc,
  usePref,
  type Tone,
  usePaged, Pager,
} from '../ui';
import { fmtInt, plural, toMs } from '../lib/format';
import { useConsole } from '../lib/console';
import { DriveBrowser } from './DriveBrowser';
import { GmailScanner } from './GmailScanner';
import { FolderIcon } from './icons';
import './knowledge.css';

// ─── Derived document facets ─────────────────────────────────────────────────
// Brand and document type aren't stored; they're derived from the title (and the
// source for emails) so the list can be filtered the way the support team thinks.

const BRANDS: { name: string; re: RegExp }[] = [
  { name: 'Deye', re: /\bdeye\b/i },
  { name: 'Solis', re: /\b(solis|ginlong)\b/i },
  { name: 'SAJ', re: /\bsaj\b/i },
  { name: 'GoodWe', re: /\bgood\s?we\b/i },
  { name: 'Sigenergy', re: /\bsigen(ergy|stor|cloud)?\b/i },
  { name: 'Sungrow', re: /\bsungrow\b/i },
  { name: 'Solarman', re: /\bsolarman\b/i },
  { name: 'Dyness', re: /\bdyness\b/i },
  { name: 'Growatt', re: /\bgrowatt\b/i },
  { name: 'WHES', re: /\bwhes\b/i },
  { name: 'SOFAR', re: /\bsofar\b/i },
  { name: 'Fronius', re: /\bfronius\b/i },
  { name: 'Huawei', re: /\bhuawei\b/i },
  { name: 'BYD', re: /\bbyd\b/i },
  { name: 'Pylontech', re: /\bpylon(tech)?\b/i },
  { name: 'AlphaESS', re: /\balpha\s?ess\b/i },
  { name: 'Fox ESS', re: /\bfox\s?ess\b/i },
  { name: 'Enphase', re: /\benphase\b/i },
];
const OTHER = 'Other';

type DocType = 'manual' | 'warranty' | 'datasheet' | 'email' | 'other';
const DOC_TYPE_LABEL: Record<DocType, string> = {
  manual: 'Manual',
  warranty: 'Warranty',
  datasheet: 'Datasheet',
  email: 'Email',
  other: 'Other',
};

type DocStatus = 'ok' | 'low' | 'corrupted' | 'failed' | 'unassessed';
const DOC_STATUS: Record<DocStatus, { label: string; tone: Tone; hint: string }> = {
  ok: { label: 'OK', tone: 'success', hint: 'Text extracted cleanly' },
  low: { label: 'Low text', tone: 'warning', hint: 'Thin text — needs OCR' },
  corrupted: { label: 'Corrupted', tone: 'danger', hint: 'Garbled text (broken font encoding) — needs OCR' },
  failed: { label: 'Failed', tone: 'danger', hint: 'Ingest failed or was skipped — no usable text' },
  unassessed: { label: 'Not assessed', tone: 'neutral', hint: 'Run “Check text quality” to assess' },
};
const STATUS_ORDER: DocStatus[] = ['ok', 'low', 'corrupted', 'failed', 'unassessed'];

type SortKey = 'name' | 'newest' | 'oldest' | 'chunks';
const SORTS: { value: SortKey; label: string }[] = [
  { value: 'newest', label: 'Last synced — newest' },
  { value: 'oldest', label: 'Last synced — oldest' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'chunks', label: 'Chunks (most first)' },
];

const STALE_DAYS = 90;

function brandOf(title: string): string {
  return BRANDS.find((b) => b.re.test(title))?.name ?? OTHER;
}
function typeOf(d: IngestedDocument): DocType {
  if (d.source === 'gmail') return 'email';
  const t = d.title.toLowerCase();
  if (/warrant|guarantee/.test(t)) return 'warranty';
  if (/data\s?sheet|spec(ification)?s?\b|spec sheet|\bds\b/.test(t)) return 'datasheet';
  if (/manual|guide|install|instruction|quick\s?start|\bqsg\b|handbook|user/.test(t)) return 'manual';
  return 'other';
}
function statusOf(d: IngestedDocument): DocStatus {
  if (d.status === 'failed' || d.status === 'skipped') return 'failed';
  if (d.text_quality === 'corrupted') return 'corrupted';
  if (d.text_quality === 'low') return 'low';
  if (d.text_quality === 'ok') return 'ok';
  return 'unassessed';
}
// Docs that an OCR re-ingest should retry (mirrors the backend's selection).
const isFlagged = (d: IngestedDocument) =>
  d.source === 'google-drive' &&
  (d.text_quality === 'low' || d.text_quality === 'corrupted' || d.status === 'skipped' || d.status === 'failed');

interface Row {
  doc: IngestedDocument;
  brand: string;
  type: DocType;
  status: DocStatus;
  syncedMs: number;
  stale: boolean;
}

/** Filters a deep link can set: ?status=<DocStatus|flagged>&q=<text>. "flagged" = unreadable text (the dashboard link). */
function filtersFromSearch(search?: string): { status: 'all' | DocStatus; q: string } {
  const p = new URLSearchParams(search ?? '');
  const raw = p.get('status');
  const status = raw === 'flagged' ? 'corrupted' : raw && raw in DOC_STATUS ? (raw as DocStatus) : 'all';
  return { status, q: p.get('q') ?? '' };
}

export function KnowledgeTab({ user, onAuthError, search: urlSearch }: { user: AuthenticatedUser; onAuthError: () => void; search?: string }) {
  const { toast, navigate } = useConsole();
  const canIngest = hasPermission(user.role, 'run_ingest');

  const [docs, setDocs] = useState<IngestedDocument[] | null>(null);
  const [folders, setFolders] = useState<DriveFolderSource[] | null>(null);
  const [driveConnected, setDriveConnected] = useState<boolean | null>(null);
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [reingesting, setReingesting] = useState(false);
  const [assessing, setAssessing] = useState(false);
  const [resyncing, setResyncing] = useState(false);

  const [driveOpen, setDriveOpen] = useState(false);
  const [gmailOpen, setGmailOpen] = useState(false);
  const [gmailRunning, setGmailRunning] = useState(false);

  // Filters
  const [search, setSearch] = useState(() => filtersFromSearch(urlSearch).q);
  const [brand, setBrand] = useState('all');
  const [type, setType] = useState<'all' | DocType>('all');
  const [status, setStatus] = useState<'all' | DocStatus>(() => filtersFromSearch(urlSearch).status);
  // A new deep link while this tab is already open (dashboard → KB) re-applies its filters.
  const lastUrl = useRef(urlSearch);
  useEffect(() => {
    if (lastUrl.current === urlSearch) return;
    lastUrl.current = urlSearch;
    const f = filtersFromSearch(urlSearch);
    setStatus(f.status);
    setSearch(f.q);
  }, [urlSearch]);
  const [sort, setSort] = usePref<SortKey>('kb.sort', 'newest');


  const handle = (err: unknown, fallback: string) => {
    if (err instanceof AuthError) return onAuthError();
    setError(err instanceof ApiError ? err.message || fallback : fallback);
  };

  // Ref so `load` stays stable even if the parent passes a new onAuthError each render.
  const authRef = useRef(onAuthError);
  authRef.current = onAuthError;

  const load = useCallback(
    () =>
      Promise.all([listDocuments(), listFolderSources(), listConnections()])
        .then(([d, f, c]) => {
          setDocs(d.documents);
          setFolders(f.folders);
          setDriveConnected(c.connections.find((x) => x.provider === 'google-drive')?.connected ?? false);
          setGmailConnected(c.connections.find((x) => x.provider === 'gmail')?.connected ?? false);
          setLoadError('');
        })
        .catch((err) => {
          if (err instanceof AuthError) return authRef.current();
          setLoadError(err instanceof ApiError ? err.message || 'Couldn’t load the knowledge base.' : 'Couldn’t load the knowledge base.');
        }),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // ── Actions ────────────────────────────────────────────────────────────────
  async function onSync(f: DriveFolderSource) {
    setBusy(f.id);
    setError('');
    try {
      const r = await syncFolderSource(f.id);
      await load();
      toast({ text: `Synced “${f.name}”: ${fmtInt(r.ingested)} ingested, ${fmtInt(r.failed)} failed.`, tone: r.failed ? 'info' : 'success' });
    } catch (err) {
      handle(err, 'Sync failed.');
    } finally {
      setBusy(null);
    }
  }

  async function onSyncAll() {
    setSyncingAll(true);
    setError('');
    try {
      const { folders: results } = await syncAllFolderSources();
      const failed = results.filter((r) => r.error);
      if (failed.length) {
        setError(`Synced with issues on ${failed.length} folder(s): ${failed.map((f) => f.name).join(', ')} — ${failed[0].error}`);
      } else {
        toast({ text: `Synced ${plural(results.length, 'folder')}.`, tone: 'success' });
      }
      await load();
    } catch (err) {
      handle(err, 'Sync all failed.');
    } finally {
      setSyncingAll(false);
    }
  }

  async function onResyncAll() {
    if (
      !window.confirm(
        'Reset & re-sync all: this deletes every ingested Drive document and re-extracts them all from scratch (Claude + OCR). Your Drive files are not touched. Continue?',
      )
    )
      return;
    setResyncing(true);
    setError('');
    try {
      const { folders: results } = await resyncAll();
      const failed = results.filter((r) => r.error);
      if (failed.length) {
        setError(`Re-synced with issues on ${failed.length} folder(s): ${failed.map((f) => f.name).join(', ')} — ${failed[0].error}`);
      } else {
        toast({ text: 'Reset & re-sync finished.', tone: 'success' });
      }
      await load();
    } catch (err) {
      handle(err, 'Reset & re-sync failed.');
    } finally {
      setResyncing(false);
    }
  }

  async function onRemoveFolder(f: DriveFolderSource) {
    if (!window.confirm(`Remove “${f.name}” as a source? Its ingested documents are removed from the knowledge base too. Your Drive files are not touched.`)) return;
    setBusy(f.id);
    setError('');
    try {
      await removeFolderSource(f.id, true);
      await load();
      toast({ text: `Removed “${f.name}”.`, tone: 'success' });
    } catch (err) {
      handle(err, 'Couldn’t remove the folder.');
    } finally {
      setBusy(null);
    }
  }

  async function onAssess() {
    setAssessing(true);
    setError('');
    try {
      await assessDocuments();
      await load();
      toast({ text: 'Text quality check finished.', tone: 'success' });
    } catch (err) {
      handle(err, 'Quality check failed.');
    } finally {
      setAssessing(false);
    }
  }

  async function onReingestFlagged() {
    setReingesting(true);
    setError('');
    try {
      await reingestFlaggedDocuments();
      await load();
      toast({ text: 'Flagged documents re-ingested with OCR.', tone: 'success' });
    } catch (err) {
      handle(err, 'Re-ingest failed.');
    } finally {
      setReingesting(false);
    }
  }

  async function onRemoveDoc(d: IngestedDocument) {
    if (!window.confirm(`Remove “${d.title}” from the knowledge base? The original file/email is not touched.`)) return;
    setBusy(d.id);
    setError('');
    try {
      await removeDocument(d.id);
      await load();
      toast({ text: 'Document removed.', tone: 'success' });
    } catch (err) {
      handle(err, 'Couldn’t remove the document.');
    } finally {
      setBusy(null);
    }
  }

  const closeDrive = useCallback(() => setDriveOpen(false), []);
  const closeGmail = useCallback(() => setGmailOpen(false), []);
  const onGmailScanned = useCallback(
    (r: GmailScanResult) => {
      void load();
      toast({ text: `Gmail “${r.labelName}”: ${fmtInt(r.ingested)} ingested, ${fmtInt(r.skipped)} skipped, ${fmtInt(r.failed)} failed.`, tone: 'success' });
    },
    [load, toast],
  );

  // ── Derived data ───────────────────────────────────────────────────────────
  const rows = useMemo<Row[]>(() => {
    const now = Date.now();
    return (docs ?? []).map((doc) => {
      const syncedMs = toMs(doc.ingested_at) ?? 0;
      return {
        doc,
        brand: brandOf(doc.title),
        type: typeOf(doc),
        status: statusOf(doc),
        syncedMs,
        stale: syncedMs > 0 && now - syncedMs > STALE_DAYS * 86_400_000,
      };
    });
  }, [docs]);

  const stats = useMemo(() => {
    const s = {
      drive: 0, email: 0, chunks: 0, flagged: 0, stale: 0,
      byStatus: { ok: 0, low: 0, corrupted: 0, failed: 0, unassessed: 0 } as Record<DocStatus, number>,
      byBrand: new Map<string, number>(),
      byType: { manual: 0, warranty: 0, datasheet: 0, email: 0, other: 0 } as Record<DocType, number>,
    };
    for (const r of rows) {
      if (r.doc.source === 'gmail') s.email++; else s.drive++;
      s.chunks += r.doc.chunk_count;
      if (isFlagged(r.doc)) s.flagged++;
      if (r.stale) s.stale++;
      s.byStatus[r.status]++;
      s.byType[r.type]++;
      s.byBrand.set(r.brand, (s.byBrand.get(r.brand) ?? 0) + 1);
    }
    return s;
  }, [rows]);

  const brandOptions = useMemo(() => {
    const named = BRANDS.map((b) => b.name).filter((n) => stats.byBrand.has(n));
    return stats.byBrand.has(OTHER) ? [...named, OTHER] : named;
  }, [stats]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = rows.filter(
      (r) =>
        (brand === 'all' || r.brand === brand) &&
        (type === 'all' || r.type === type) &&
        (status === 'all' || r.status === status) &&
        (q === '' || r.doc.title.toLowerCase().includes(q)),
    );
    out.sort((a, b) => {
      if (sort === 'name') return a.doc.title.localeCompare(b.doc.title);
      if (sort === 'oldest') return a.syncedMs - b.syncedMs;
      if (sort === 'chunks') return b.doc.chunk_count - a.doc.chunk_count;
      return b.syncedMs - a.syncedMs;
    });
    return out;
  }, [rows, search, brand, type, status, sort]);

  const paged = usePaged(filtered, [search, brand, type, status, sort]);
  const shown = paged.slice;
  const filtersActive = search.trim() !== '' || brand !== 'all' || type !== 'all' || status !== 'all';
  const resetFilters = () => {
    setSearch('');
    setBrand('all');
    setType('all');
    setStatus('all');
  };

  const loading = docs === null && !loadError;
  const flaggedBreakdown = (['corrupted', 'low', 'failed'] as const).filter((k) => stats.byStatus[k] > 0);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loadError && docs === null) {
    return (
      <div className="kb">
        <ErrorState title="Couldn’t load the knowledge base" detail={loadError} onRetry={() => void load()} />
      </div>
    );
  }

  return (
    <div className="kb">
      <header className="kb-head">
        <div className="kb-head-t">
          <h2>Knowledge base</h2>
          <p>Drive manuals, warranties and datasheets plus scanned support emails that ground the AI agent’s replies.</p>
        </div>
        {canIngest && (
          <div className="kb-head-a">
            <button type="button" className="c-btn" onClick={() => setDriveOpen(true)}>
              <Icon name="plus" size={16} /> Add from Drive
            </button>
            <button type="button" className="c-btn primary" onClick={() => setGmailOpen(true)} disabled={gmailRunning && !gmailOpen}
              title={gmailRunning ? 'A scan is already running' : 'Scan a Gmail label into the knowledge base'}>
              <Icon name="mail" size={16} /> {gmailRunning ? 'Scanning Gmail…' : 'Scan Gmail'}
            </button>
          </div>
        )}
      </header>

      {error && (
        <div className="c-banner t-danger kb-banner" role="alert">
          <Icon name="alert" />
          <span className="c-grow">{error}</span>
          <button type="button" className="c-iconbtn" onClick={() => setError('')} aria-label="Dismiss error">
            <Icon name="x" size={16} />
          </button>
        </div>
      )}

      {gmailRunning && !gmailOpen && (
        <div className="c-banner t-info kb-banner" role="status">
          <Icon name="mail" />
          <span className="c-grow">A Gmail scan is running in the background. The document list refreshes when it finishes.</span>
        </div>
      )}

      {/* ── Summary strip ─────────────────────────────────────────────────── */}
      <div className="kb-summary" aria-busy={loading}>
        <div className="kb-metric">
          <span className="kb-metric-k">Documents</span>
          <span className="kb-metric-v">{loading ? '—' : fmtInt(rows.length)}</span>
          <span className="kb-metric-s">
            {loading ? <span className="c-skel" /> : `${fmtInt(stats.drive)} Drive · ${fmtInt(stats.email)} email`}
          </span>
        </div>
        <div className="kb-metric">
          <span className="kb-metric-k">Chunks indexed</span>
          <span className="kb-metric-v">{loading ? '—' : fmtInt(stats.chunks)}</span>
          <span className="kb-metric-s">
            {loading ? <span className="c-skel" /> : stats.stale > 0 ? `${fmtInt(stats.stale)} stale (> ${STALE_DAYS} d)` : 'All synced recently'}
          </span>
        </div>
        <div className="kb-metric">
          <span className="kb-metric-k">Folder sources</span>
          <span className="kb-metric-v">{folders ? fmtInt(folders.length) : '—'}</span>
          <span className="kb-metric-s">
            {loading ? <span className="c-skel" /> : `${fmtInt(stats.byStatus.unassessed)} not assessed`}
          </span>
        </div>
        <div className={`kb-metric kb-flagged ${!loading && stats.flagged === 0 ? 'is-clear' : ''}`}>
          <div className="kb-flagged-top">
            <span className="kb-metric-k">Flagged for OCR</span>
          </div>
          <span className="kb-metric-v">{loading ? '—' : fmtInt(stats.flagged)}</span>
          {!loading && (
            <div className="kb-flag-break">
              {flaggedBreakdown.length === 0 ? (
                <span className="kb-metric-s">No unusable Drive documents found.</span>
              ) : (
                flaggedBreakdown.map((k) => (
                  <Chip key={k} tone={DOC_STATUS[k].tone} active={status === k} count={stats.byStatus[k]} onClick={() => setStatus(status === k ? 'all' : k)}>
                    {DOC_STATUS[k].label}
                  </Chip>
                ))
              )}
            </div>
          )}
          {canIngest && !loading && rows.length > 0 && (
            <div className="kb-flag-acts">
              <button type="button" className="c-btn sm" disabled={assessing || reingesting} onClick={onAssess}
                title="Re-check the extracted text of every document for corruption">
                <Icon name="shield" size={15} /> {assessing ? 'Checking…' : 'Check text quality'}
              </button>
              {stats.flagged > 0 && (
                <button type="button" className="c-btn sm primary" disabled={reingesting || assessing} onClick={onReingestFlagged}
                  title="Re-extract flagged documents with OCR">
                  <Icon name="refresh" size={15} /> {reingesting ? 'Re-ingesting…' : `Re-ingest ${fmtInt(stats.flagged)} flagged (OCR)`}
                </button>
              )}
            </div>
          )}
          {(assessing || reingesting) && (
            <div className="kb-progress" role="progressbar" aria-label={assessing ? 'Checking text quality' : 'Re-ingesting flagged documents'} style={{ marginTop: 8 }} />
          )}
        </div>
      </div>

      {/* ── Folder sources ────────────────────────────────────────────────── */}
      <Section
        title="Drive folder sources"
        sub={folders ? plural(folders.length, 'folder') : undefined}
        actions={
          canIngest && folders && folders.length > 0 ? (
            <>
              <button type="button" className="c-btn sm" disabled={syncingAll || resyncing} onClick={onSyncAll}>
                <Icon name="refresh" size={15} /> {syncingAll ? 'Syncing…' : 'Sync all'}
              </button>
              <Menu
                label="More folder actions"
                items={[
                  { label: resyncing ? 'Resetting…' : 'Reset & re-sync all', icon: 'alert', danger: true, disabled: resyncing || syncingAll, onSelect: () => void onResyncAll() },
                ]}
              />
            </>
          ) : undefined
        }
      >
        {(syncingAll || resyncing) && (
          <div className="kb-progress" role="progressbar" aria-label={resyncing ? 'Resetting and re-syncing' : 'Syncing all folders'} />
        )}
        {folders === null ? (
          <SkeletonRows rows={2} cols={3} />
        ) : folders.length === 0 ? (
          <p className="kb-folders-empty">
            No folder sources yet.{' '}
            {canIngest && driveConnected && (
              <button type="button" className="c-link" onClick={() => setDriveOpen(true)}>Add a Drive folder</button>
            )}
          </p>
        ) : (
          <ul className="kb-folders">
            {folders.map((f) => {
              const working = busy === f.id || syncingAll;
              return (
                <li key={f.id} className="kb-folder">
                  <FolderIcon />
                  <span className="kb-folder-name">
                    {f.web_url ? (
                      <a href={f.web_url} target="_blank" rel="noreferrer noopener"><Trunc text={f.name} /></a>
                    ) : (
                      <Trunc text={f.name} />
                    )}
                    {f.recursive && <Pill tone="neutral">Recursive</Pill>}
                  </span>
                  <span className="kb-folder-meta">
                    {f.last_file_count != null ? plural(f.last_file_count, 'file') : 'not synced'}
                    {f.last_synced_at && <> · synced <RelTime t={f.last_synced_at} /></>}
                  </span>
                  {canIngest ? (
                    <span className="kb-folder-acts">
                      <button type="button" className="c-iconbtn" disabled={working} onClick={() => void onSync(f)}
                        title={working ? 'Syncing…' : 'Sync folder'} aria-label={`Sync ${f.name}`}>
                        <Icon name="refresh" size={16} />
                      </button>
                      <button type="button" className="c-iconbtn" disabled={working} onClick={() => void onRemoveFolder(f)}
                        title="Remove folder" aria-label={`Remove ${f.name}`}>
                        <Icon name="x" size={16} />
                      </button>
                    </span>
                  ) : <span />}
                  {busy === f.id && <div className="kb-progress" role="progressbar" aria-label={`Working on ${f.name}`} />}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* ── Documents ─────────────────────────────────────────────────────── */}
      <Section
        title="Documents"
        sub={docs ? `${fmtInt(filtered.length)} of ${fmtInt(rows.length)}` : undefined}
        actions={
          <button type="button" className="c-iconbtn" onClick={() => void load()} title="Refresh" aria-label="Refresh documents">
            <Icon name="refresh" size={16} />
          </button>
        }
      >
        <div className="kb-filters">
          <div className="kb-filter-row">
            <SearchInput value={search} onChange={setSearch} placeholder="Search documents by name…" label="Search documents" />
            <label className="kb-select">
              <span>Brand</span>
              <select className="c-select" value={brand} onChange={(e) => setBrand(e.target.value)}>
                <option value="all">All brands</option>
                {brandOptions.map((b) => (
                  <option key={b} value={b}>{b} ({fmtInt(stats.byBrand.get(b) ?? 0)})</option>
                ))}
              </select>
            </label>
            <label className="kb-select">
              <span>Type</span>
              <select className="c-select" value={type} onChange={(e) => setType(e.target.value as 'all' | DocType)}>
                <option value="all">All types</option>
                {(Object.keys(DOC_TYPE_LABEL) as DocType[]).map((t) => (
                  <option key={t} value={t}>{DOC_TYPE_LABEL[t]} ({fmtInt(stats.byType[t])})</option>
                ))}
              </select>
            </label>
            <label className="kb-select">
              <span>Sort</span>
              <select className="c-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
          </div>
          <div className="kb-filter-row c-chips" role="group" aria-label="Filter by status">
            <Chip active={status === 'all'} onClick={() => setStatus('all')} count={rows.length}>All statuses</Chip>
            {STATUS_ORDER.map((k) => (
              <Chip key={k} tone={DOC_STATUS[k].tone} active={status === k} count={stats.byStatus[k]} onClick={() => setStatus(status === k ? 'all' : k)}>
                {DOC_STATUS[k].label}
              </Chip>
            ))}
            {filtersActive && (
              <button type="button" className="c-btn sm ghost kb-reset" onClick={resetFilters}>Clear filters</button>
            )}
          </div>
        </div>

        {loading ? (
          <SkeletonRows rows={8} cols={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="book"
            title="The knowledge base is empty"
            hint={
              canIngest
                ? 'Add manuals, warranties and datasheets from Google Drive, or scan a Gmail label of support emails.'
                : 'Nothing has been ingested yet. Ask an admin to add documents.'
            }
            action={
              canIngest ? (
                <div className="c-row" style={{ justifyContent: 'center' }}>
                  <button type="button" className="c-btn primary" onClick={() => setDriveOpen(true)}><Icon name="plus" size={16} /> Add from Drive</button>
                  <button type="button" className="c-btn" onClick={() => setGmailOpen(true)}><Icon name="mail" size={16} /> Scan Gmail</button>
                </div>
              ) : undefined
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="search"
            title="No documents match these filters"
            hint={search.trim() ? <>Nothing matches “{search.trim()}”.</> : 'Try a different brand, type or status.'}
            action={<button type="button" className="c-btn" onClick={resetFilters}>Clear filters</button>}
          />
        ) : (
          <>
            <div className="kb-tablewrap">
              <table className="c-table kb-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col" className="kb-col-brand">Brand</th>
                    <th scope="col" className="kb-col-type">Type</th>
                    <th scope="col" className="kb-col-src">Source</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num kb-col-chunks">Chunks</th>
                    <th scope="col" className="kb-col-when">Last synced</th>
                    <th scope="col"><span className="c-sr">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const d = r.doc;
                    const st = DOC_STATUS[r.status];
                    return (
                      <tr key={d.id}>
                        <td className="name">
                          <div className="kb-docname">
                            {d.web_url ? (
                              <a href={d.web_url} target="_blank" rel="noreferrer noopener"><Trunc text={d.title} /></a>
                            ) : (
                              <Trunc text={d.title} />
                            )}
                          </div>
                        </td>
                        <td className="kb-col-brand"><span className={`kb-tag ${r.brand === OTHER ? 'is-other' : ''}`}>{r.brand}</span></td>
                        <td className="kb-col-type"><span className={`kb-tag ${r.type === 'other' ? 'is-other' : ''}`}>{DOC_TYPE_LABEL[r.type]}</span></td>
                        <td className="kb-col-src">
                          <span className="kb-src">
                            {d.source === 'gmail' ? <Icon name="mail" size={14} /> : <FolderIcon />}
                            {d.source === 'gmail' ? 'Gmail' : 'Drive'}
                          </span>
                        </td>
                        <td>
                          <span className="c-row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                            <Pill tone={st.tone} dot title={d.status === 'skipped' ? 'Skipped at ingest — no usable text' : st.hint}>
                              {d.status === 'skipped' ? 'Skipped' : st.label}
                            </Pill>
                            {r.stale && <Pill tone="warning" title={`Last synced more than ${STALE_DAYS} days ago`}>Stale</Pill>}
                          </span>
                        </td>
                        <td className="num kb-col-chunks">{fmtInt(d.chunk_count)}</td>
                        <td className={`kb-col-when ${r.stale ? 'kb-stale' : ''}`}><RelTime t={d.ingested_at} /></td>
                        <td className="kb-acts-cell">
                          <span className="kb-rowacts">
                            {d.web_url && (
                              <a className="c-iconbtn" href={d.web_url} target="_blank" rel="noreferrer noopener"
                                title={`Open original in ${d.source === 'gmail' ? 'Gmail' : 'Drive'}`} aria-label={`Open ${d.title}`}>
                                <Icon name="external" size={16} />
                              </a>
                            )}
                            {canIngest && (
                              <button type="button" className="c-iconbtn" disabled={busy === d.id} onClick={() => void onRemoveDoc(d)}
                                title="Remove document" aria-label={`Remove ${d.title}`}>
                                <Icon name="x" size={16} />
                              </button>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager paged={paged} noun="document" />
          </>
        )}
      </Section>

      {/* ── Add from Drive drawer ─────────────────────────────────────────── */}
      <Drawer open={driveOpen} onClose={closeDrive} title="Add from Google Drive" sub="Add folders as sources or ingest individual files." wide>
        {driveConnected ? (
          <DriveBrowser onAuthError={onAuthError} onChange={() => void load()} />
        ) : (
          <EmptyState
            icon="link"
            title="Google Drive isn’t connected"
            hint="Connect Google Drive to browse folders and add files to the knowledge base."
            action={<button type="button" className="c-btn primary" onClick={() => { closeDrive(); navigate('connections'); }}>Open Connections</button>}
          />
        )}
      </Drawer>

      {/* ── Scan Gmail drawer (single entry point) ────────────────────────── */}
      <Drawer open={gmailOpen} onClose={closeGmail} title="Scan Gmail into the knowledge base" sub="Gmail → RAG. Read-only: nothing is sent.">
        {gmailConnected === false ? (
          <EmptyState
            icon="mail"
            title="Gmail isn’t connected"
            hint="Connect Gmail to scan a label of support emails into the knowledge base."
            action={<button type="button" className="c-btn primary" onClick={() => { closeGmail(); navigate('connections'); }}>Open Connections</button>}
          />
        ) : (
          <GmailScanner onAuthError={onAuthError} onScanned={onGmailScanned} onRunningChange={setGmailRunning} />
        )}
      </Drawer>
    </div>
  );
}
