import { useEffect, useState } from 'react';
import {
  hasPermission,
  type AuthenticatedUser,
  type DriveFolderSource,
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
import { DriveBrowser } from './DriveBrowser';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FolderIcon,
  MailIcon,
  RefreshIcon,
  ResetIcon,
  SearchIcon,
  ShieldIcon,
  TrashIcon,
} from './icons';

const SOURCE_LABEL: Record<IngestedDocument['source'], string> = {
  'google-drive': 'Drive',
  gmail: 'Email',
};

const STATUS_CLASS: Record<string, string> = {
  ingested: 'green',
  skipped: 'amber',
  failed: 'amber',
};

// Text-quality badge: only shown when the stored text is not usable.
const QUALITY_BADGE: Record<string, { label: string; cls: string }> = {
  low: { label: 'thin text — needs OCR', cls: 'amber' },
  corrupted: { label: 'corrupted — needs OCR', cls: 'danger' },
};

// How many ingested documents to show per page.
const DOCS_PER_PAGE = 12;

// Docs that aren't cleanly usable: garbled text, or no text at all (image-only
// PDFs marked skipped/failed). These are the ones an OCR re-ingest should retry.
const isFlagged = (d: IngestedDocument) =>
  d.source === 'google-drive' &&
  (d.text_quality === 'low' || d.text_quality === 'corrupted' || d.status === 'skipped' || d.status === 'failed');

type KbTab = 'drive' | 'gmail';

export function KnowledgeTab({ user, onAuthError }: { user: AuthenticatedUser; onAuthError: () => void }) {
  const canIngest = hasPermission(user.role, 'run_ingest');
  const [docs, setDocs] = useState<IngestedDocument[] | null>(null);
  const [folders, setFolders] = useState<DriveFolderSource[] | null>(null);
  const [driveConnected, setDriveConnected] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [reingesting, setReingesting] = useState(false);
  const [assessing, setAssessing] = useState(false);
  const [resyncing, setResyncing] = useState(false);

  // View controls: Drive/Gmail tab, document search, and pagination.
  const [kbTab, setKbTab] = useState<KbTab>('drive');
  const [docSearch, setDocSearch] = useState('');
  const [docPage, setDocPage] = useState(0);

  // Reset to the first page whenever the filter changes.
  useEffect(() => {
    setDocPage(0);
  }, [kbTab, docSearch]);

  const handle = (err: unknown, fallback: string) => {
    if (err instanceof AuthError) return onAuthError();
    setError(err instanceof ApiError ? err.message || fallback : fallback);
  };

  const load = () =>
    Promise.all([listDocuments(), listFolderSources(), listConnections()])
      .then(([d, f, c]) => {
        setDocs(d.documents);
        setFolders(f.folders);
        setDriveConnected(
          c.connections.find((x) => x.provider === 'google-drive')?.connected ?? false,
        );
      })
      .catch((err) => handle(err, 'Couldn’t load the knowledge base.'));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSync(id: string) {
    setBusy(id);
    setError('');
    try {
      await syncFolderSource(id);
      await load();
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
      }
      await load();
    } catch (err) {
      handle(err, 'Reset & re-sync failed.');
    } finally {
      setResyncing(false);
    }
  }

  async function onRemoveFolder(id: string) {
    setBusy(id);
    setError('');
    try {
      await removeFolderSource(id, true);
      await load();
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
    } catch (err) {
      handle(err, 'Re-ingest failed.');
    } finally {
      setReingesting(false);
    }
  }

  async function onRemoveDoc(id: string) {
    setBusy(id);
    setError('');
    try {
      await removeDocument(id);
      await load();
    } catch (err) {
      handle(err, 'Couldn’t remove the document.');
    } finally {
      setBusy(null);
    }
  }

  const totalChunks = docs?.reduce((n, d) => n + d.chunk_count, 0) ?? 0;
  const flaggedCount = docs?.filter(isFlagged).length ?? 0;

  // Documents for the active tab, filtered by the search box, then paginated.
  const sourceForTab: IngestedDocument['source'] = kbTab === 'drive' ? 'google-drive' : 'gmail';
  const query = docSearch.trim().toLowerCase();
  const filteredDocs = (docs ?? []).filter(
    (d) => d.source === sourceForTab && (query === '' || d.title.toLowerCase().includes(query)),
  );
  const pageCount = Math.max(1, Math.ceil(filteredDocs.length / DOCS_PER_PAGE));
  const page = Math.min(docPage, pageCount - 1);
  const pagedDocs = filteredDocs.slice(page * DOCS_PER_PAGE, page * DOCS_PER_PAGE + DOCS_PER_PAGE);

  return (
    <div className="col">
      {error && <span className="err">{error}</span>}

      {/* ── Overview ─────────────────────────────────────────────────────── */}
      <div className="stat-row">
        <div className="stat">
          <span className="stat-value">{docs ? docs.length : '—'}</span>
          <span className="stat-label">Documents</span>
        </div>
        <div className="stat">
          <span className="stat-value">{docs ? totalChunks.toLocaleString() : '—'}</span>
          <span className="stat-label">Chunks indexed</span>
        </div>
        <div className="stat">
          <span className="stat-value">{folders ? folders.length : '—'}</span>
          <span className="stat-label">Folder sources</span>
        </div>
        <div className={`stat${flaggedCount > 0 ? ' stat-flag' : ''}`}>
          <span className="stat-value">{docs ? flaggedCount : '—'}</span>
          <span className="stat-label">Need OCR</span>
        </div>
      </div>

      {/* ── Source tabs (centered pill toggle) ───────────────────────────── */}
      <div className="pilltabs-wrap">
        <div className="pilltabs" role="tablist" aria-label="Knowledge source">
          <button
            role="tab"
            type="button"
            aria-selected={kbTab === 'drive'}
            onClick={() => setKbTab('drive')}
          >
            <FolderIcon /> Drive
          </button>
          <button
            role="tab"
            type="button"
            aria-selected={kbTab === 'gmail'}
            onClick={() => setKbTab('gmail')}
          >
            <MailIcon /> Gmail
          </button>
        </div>
      </div>

      {/* ── Add from Drive (Drive tab only) ──────────────────────────────── */}
      {kbTab === 'drive' && canIngest && driveConnected && (
        <section className="card">
          <div className="kb-browse">
            <DriveBrowser onAuthError={onAuthError} onChange={load} />
          </div>
        </section>
      )}
      {kbTab === 'drive' && canIngest && driveConnected === false && (
        <section className="card kb-connect-hint">
          <div className="card-h">
            <h2>Add documents from Drive</h2>
          </div>
          <p className="how" style={{ marginTop: 0 }}>
            Connect Google Drive from <b>Connections</b> to browse folders and add files to the
            knowledge base.
          </p>
        </section>
      )}

      {/* ── Sources + documents in a single card (folders only on Drive) ──── */}
      <section className="card kb-main">
        {kbTab === 'drive' && (
          <div className="kb-section">
            <div className="card-h">
              <h2>Drive folder sources</h2>
            <div className="drive-selall">
              <span className="eyebrow">{folders ? `${folders.length} folders` : '…'}</span>
              {canIngest && folders && folders.length > 0 && (
                <>
                  <button className="btn ghost sm ico" type="button" disabled={syncingAll || resyncing} onClick={onSyncAll} title="Sync all folders">
                    <RefreshIcon /> {syncingAll ? 'Syncing…' : 'Sync all'}
                  </button>
                  <button className="btn ghost sm danger ico" type="button" disabled={resyncing || syncingAll} onClick={onResyncAll} title="Reset & re-sync all folders">
                    <ResetIcon /> {resyncing ? 'Resetting…' : 'Reset all'}
                  </button>
                </>
              )}
            </div>
          </div>
          <p className="how" style={{ marginTop: 0 }}>
            Folders selected as knowledge sources. Add more with <b>Browse &amp; select from Drive</b> above.
          </p>
          {(syncingAll || resyncing) && (
            <div className="progress-bar" role="progressbar" aria-label={resyncing ? 'Resetting and re-syncing' : 'Syncing all folders'} />
          )}
          <div className="user-table">
            {folders?.map((f) => (
              <div key={f.id} className="user-row">
                <div className="user-row-main">
                  <FolderIcon className="row-ico" />
                  <span className="user-name">{f.name}</span>
                  {f.recursive && <span className="pill">Recursive</span>}
                  <span className="user-email">
                    {f.last_file_count != null ? `${f.last_file_count} files` : 'not synced'}
                    {f.last_synced_at ? ` · ${new Date(f.last_synced_at).toLocaleDateString()}` : ''}
                  </span>
                </div>
                {canIngest && (
                  <div className="user-row-actions">
                    <button
                      className="icon-btn"
                      disabled={busy === f.id || syncingAll}
                      onClick={() => onSync(f.id)}
                      title={busy === f.id || syncingAll ? 'Syncing…' : 'Sync folder'}
                      aria-label="Sync folder"
                    >
                      <RefreshIcon />
                    </button>
                    <button
                      className="icon-btn danger"
                      disabled={busy === f.id || syncingAll}
                      onClick={() => onRemoveFolder(f.id)}
                      title="Remove folder"
                      aria-label="Remove folder"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                )}
                {(busy === f.id || syncingAll) && (
                  <div className="progress-bar row-progress" role="progressbar" aria-label={`Syncing ${f.name}`} />
                )}
              </div>
            ))}
            {folders === null && !error && <p className="how">Loading…</p>}
            {folders?.length === 0 && <p className="how">No folder sources yet.</p>}
            </div>
          </div>
        )}

        {/* ── Documents (same card; separated when folders are shown above) ── */}
        <div className={`kb-section${kbTab === 'drive' ? ' kb-section-sep' : ''}`}>
        <div className="card-h">
          <h2>{kbTab === 'drive' ? 'Drive documents' : 'Gmail documents'}</h2>
          <div className="drive-selall">
            <span className="eyebrow">
              {docs ? `${filteredDocs.length} shown` : '…'}
              {kbTab === 'drive' && flaggedCount > 0 ? ` · ${flaggedCount} need OCR` : ''}
            </span>
            {kbTab === 'drive' && canIngest && docs && docs.length > 0 && (
              <button className="btn ghost sm ico" type="button" disabled={assessing || reingesting} onClick={onAssess} title="Check text quality of ingested documents">
                <ShieldIcon /> {assessing ? 'Checking…' : 'Check quality'}
              </button>
            )}
            {kbTab === 'drive' && canIngest && flaggedCount > 0 && (
              <button className="btn ghost sm ico" type="button" disabled={reingesting || assessing} onClick={onReingestFlagged} title="Re-ingest flagged documents with OCR">
                <RefreshIcon /> {reingesting ? 'Re-ingesting…' : `Re-ingest ${flaggedCount} (OCR)`}
              </button>
            )}
          </div>
        </div>

        {/* Search */}
        <div className="kb-search">
          <SearchIcon />
          <input
            type="search"
            value={docSearch}
            onChange={(e) => setDocSearch(e.target.value)}
            placeholder={`Search ${kbTab === 'drive' ? 'Drive' : 'Gmail'} documents by name…`}
            aria-label="Search documents"
          />
        </div>

        <div className="user-table">
          {pagedDocs.map((d) => (
            <div key={d.id} className="user-row">
              <div className="user-row-main">
                <span className="pill">{SOURCE_LABEL[d.source]}</span>
                <span className="user-name">
                  {d.web_url ? (
                    <a href={d.web_url} target="_blank" rel="noreferrer noopener">{d.title}</a>
                  ) : (
                    d.title
                  )}
                </span>
                <span className={`pill ${STATUS_CLASS[d.status] ?? ''}`}>{d.status}</span>
                {d.text_quality && QUALITY_BADGE[d.text_quality] && (
                  <span className={`pill ${QUALITY_BADGE[d.text_quality].cls}`}>
                    {QUALITY_BADGE[d.text_quality].label}
                  </span>
                )}
                <span className="user-email">{d.chunk_count} chunks</span>
              </div>
              <div className="user-row-actions">
                {d.web_url && (
                  <a
                    className="icon-btn"
                    href={d.web_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={`Open original in ${SOURCE_LABEL[d.source]}`}
                    aria-label="Open original"
                  >
                    <ExternalLinkIcon />
                  </a>
                )}
                {canIngest && (
                  <button
                    className="icon-btn danger"
                    disabled={busy === d.id}
                    onClick={() => onRemoveDoc(d.id)}
                    title="Remove document"
                    aria-label="Remove document"
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>
            </div>
          ))}
          {docs === null && !error && <p className="how">Loading…</p>}
          {docs !== null && filteredDocs.length === 0 && (
            <p className="how">
              {query ? (
                <>No {kbTab === 'drive' ? 'Drive' : 'Gmail'} documents match “{docSearch.trim()}”.</>
              ) : kbTab === 'drive' ? (
                <>Nothing ingested from Drive yet. Add files with <b>Browse &amp; select from Drive</b> above.</>
              ) : (
                <>Nothing ingested from Gmail yet. Scan Gmail from <b>Connections</b> to add emails here.</>
              )}
            </p>
          )}
        </div>

        {/* Pagination */}
        {pageCount > 1 && (
          <div className="pager">
            <button
              className="icon-btn"
              type="button"
              disabled={page === 0}
              onClick={() => setDocPage(page - 1)}
              title="Previous page"
              aria-label="Previous page"
            >
              <ChevronLeftIcon />
            </button>
            <span className="eyebrow pager-label">
              Page {page + 1} of {pageCount}
            </span>
            <button
              className="icon-btn"
              type="button"
              disabled={page >= pageCount - 1}
              onClick={() => setDocPage(page + 1)}
              title="Next page"
              aria-label="Next page"
            >
              <ChevronRightIcon />
            </button>
          </div>
        )}
        </div>
      </section>
    </div>
  );
}
