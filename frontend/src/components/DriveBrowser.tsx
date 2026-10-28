import { useEffect, useState } from 'react';
import type {
  DriveFile,
  DriveFolderSource,
  FolderSyncResult,
  IngestResult,
} from '@tsba/shared';
import {
  AuthError,
  addFolderSource,
  addFolderSourcesBulk,
  ingestDriveFiles,
  listDriveFiles,
  listFolderSources,
  searchDriveFiles,
} from '../api';

interface Crumb {
  id: string;
  name: string;
}

function fmtSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(f: DriveFile): string {
  if (f.isFolder) return '📁';
  if (f.mimeType === 'application/pdf') return '📄';
  if (f.mimeType.includes('wordprocessing') || f.mimeType.includes('document')) return '📝';
  if (f.mimeType.includes('spreadsheet') || f.mimeType.includes('csv')) return '📊';
  if (f.mimeType.includes('presentation')) return '📽️';
  return '📎';
}

export function DriveBrowser({
  onAuthError,
  onChange,
}: {
  onAuthError: () => void;
  /** Called after folders/files are added or ingested, so a parent list can refresh. */
  onChange?: () => void;
}) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: 'root', name: 'My Drive' }]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [sources, setSources] = useState<DriveFolderSource[]>([]);
  const [recursive, setRecursive] = useState(true);
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState(false);
  const [hasBrowsed, setHasBrowsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [busyFolder, setBusyFolder] = useState<string | null>(null);
  const [results, setResults] = useState<IngestResult[] | null>(null);
  const [folderSummary, setFolderSummary] = useState<FolderSyncResult | null>(null);
  const [error, setError] = useState('');

  const folder = crumbs[crumbs.length - 1];
  const sourceIds = new Set(sources.map((s) => s.id));

  function fail(err: unknown, fallback: string) {
    if (err instanceof AuthError) return onAuthError();
    setError(fallback);
  }

  function loadFolder(folderId: string, append = false, pageToken?: string) {
    setLoading(true);
    setError('');
    listDriveFiles(folderId, pageToken)
      .then((r) => {
        setFiles((prev) => (append ? [...prev, ...r.files] : r.files));
        setNextPageToken(r.nextPageToken);
        setHasBrowsed(true);
      })
      .catch((err) => fail(err, 'Couldn’t list this folder.'))
      .finally(() => setLoading(false));
  }

  function loadSources() {
    // Tracks which folders are already in the knowledge base, so the file list
    // can show an "✓ added · re-sync" hint. The folder/document lists themselves
    // live on the Knowledge base tab.
    listFolderSources()
      .then((r) => setSources(r.folders))
      .catch((err) => fail(err, 'Couldn’t load selected folders.'));
  }

  useEffect(() => {
    // Search-first: don't auto-list My Drive. Folders appear once the user searches.
    loadSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addFolder(folderId: string) {
    setBusyFolder(folderId);
    setError('');
    setFolderSummary(null);
    setResults(null);
    try {
      const summary = await addFolderSource(folderId, recursive);
      setFolderSummary(summary);
      loadSources();
      onChange?.();
    } catch (err) {
      fail(err, 'Couldn’t add that folder.');
    } finally {
      setBusyFolder(null);
    }
  }

  function runSearch() {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError('');
    setSelected(new Set());
    setSelectedFolders(new Set());
    setResults(null);
    setNextPageToken(null);
    searchDriveFiles(q)
      .then((r) => {
        setFiles(r.files);
        setSearchMode(true);
      })
      .catch((err) => fail(err, 'Search failed.'))
      .finally(() => setLoading(false));
  }

  function clearSearch() {
    setQuery('');
    setSearchMode(false);
    setSelected(new Set());
    setSelectedFolders(new Set());
    // Back to the search-first empty state (don't re-list My Drive).
    setFiles([]);
    setNextPageToken(null);
    setHasBrowsed(false);
    setCrumbs([{ id: 'root', name: 'My Drive' }]);
  }

  function openFolder(f: DriveFile) {
    setSelected(new Set());
    setSelectedFolders(new Set());
    setResults(null);
    setNextPageToken(null);
    setQuery('');
    // Opening a result starts a fresh path from My Drive → that folder.
    setCrumbs(searchMode ? [{ id: 'root', name: 'My Drive' }, { id: f.id, name: f.name }] : [...crumbs, { id: f.id, name: f.name }]);
    setSearchMode(false);
    loadFolder(f.id);
  }

  function goTo(index: number) {
    const next = crumbs.slice(0, index + 1);
    setSelected(new Set());
    setSelectedFolders(new Set());
    setResults(null);
    setNextPageToken(null);
    setQuery('');
    setSearchMode(false);
    setCrumbs(next);
    loadFolder(next[next.length - 1].id);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleFolder(id: string) {
    setSelectedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addSelectedFolders() {
    if (!selectedFolders.size) return;
    setIngesting(true);
    setError('');
    setFolderSummary(null);
    setResults(null);
    try {
      const { folders } = await addFolderSourcesBulk([...selectedFolders], recursive);
      const totals = folders.reduce(
        (a, f) => ({ files: a.files + f.filesFound, ingested: a.ingested + f.ingested, failed: a.failed + f.failed }),
        { files: 0, ingested: 0, failed: 0 },
      );
      setFolderSummary({
        folderId: 'bulk',
        name: `${folders.length} folder${folders.length === 1 ? '' : 's'}`,
        filesFound: totals.files,
        ingested: totals.ingested,
        skipped: 0,
        failed: totals.failed,
        results: [],
      });
      setSelectedFolders(new Set());
      loadSources();
      onChange?.();
    } catch (err) {
      fail(err, 'Couldn’t add the selected folders.');
    } finally {
      setIngesting(false);
    }
  }

  function selectAllIngestable() {
    const ids = files.filter((f) => f.ingestable).map((f) => f.id);
    const allSelected = ids.every((id) => selected.has(id));
    setSelected(allSelected ? new Set() : new Set(ids));
  }

  function selectAllFolders() {
    const ids = files.filter((f) => f.isFolder).map((f) => f.id);
    const allSelected = ids.every((id) => selectedFolders.has(id));
    setSelectedFolders(allSelected ? new Set() : new Set(ids));
  }

  async function ingestSelected() {
    if (!selected.size) return;
    setIngesting(true);
    setError('');
    setResults(null);
    try {
      const { results } = await ingestDriveFiles([...selected]);
      setResults(results);
      setSelected(new Set());
      onChange?.();
    } catch (err) {
      fail(err, 'Ingest failed. Try again.');
    } finally {
      setIngesting(false);
    }
  }

  const ingestableCount = files.filter((f) => f.ingestable).length;
  const folderCount = files.filter((f) => f.isFolder).length;

  return (
    <div className="drive">
      <div className="card-h">
        <h3 className="drive-h">Browse &amp; select from Drive</h3>
        <div className="drive-selall">
          {folderCount > 0 && (
            <button className="linklike" type="button" onClick={selectAllFolders}>
              {files.filter((f) => f.isFolder).every((f) => selectedFolders.has(f.id))
                ? 'Clear folders'
                : `Select all folders (${folderCount})`}
            </button>
          )}
          {ingestableCount > 0 && (
            <button className="linklike" type="button" onClick={selectAllIngestable}>
              {files.filter((f) => f.ingestable).every((f) => selected.has(f.id))
                ? 'Clear files'
                : `Select all files (${ingestableCount})`}
            </button>
          )}
        </div>
      </div>

      <p className="how" style={{ margin: '4px 0 0' }}>
        Search for folders (including shared ones), tick one or more to add them to the knowledge base at
        once, or open a folder to pick individual files.
      </p>

      <form
        className="drive-search"
        onSubmit={(e) => {
          e.preventDefault();
          runSearch();
        }}
      >
        <input
          type="search"
          placeholder="Search all of Drive by name (incl. shared folders)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn" type="submit" disabled={loading || !query.trim()}>
          Search
        </button>
        {searchMode && (
          <button className="btn ghost" type="button" onClick={clearSearch}>
            Clear
          </button>
        )}
      </form>

      <div className="drive-bar">
        {searchMode ? (
          <span className="search-label">
            Search results for “{query.trim()}” — {files.length} match{files.length === 1 ? '' : 'es'}
          </span>
        ) : (
          <nav className="crumbs" aria-label="Folder path">
            {crumbs.map((c, i) => (
              <span key={c.id}>
                {i > 0 && <span className="sep">/</span>}
                <button className="crumb" type="button" disabled={i === crumbs.length - 1} onClick={() => goTo(i)}>
                  {c.name}
                </button>
              </span>
            ))}
          </nav>
        )}
        <label className="recursive-toggle">
          <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
          Include subfolders
        </label>
      </div>

      {folder.id !== 'root' && (
        <button
          className="btn add-folder-btn"
          type="button"
          disabled={busyFolder === folder.id}
          onClick={() => addFolder(folder.id)}
        >
          {busyFolder === folder.id
            ? 'Adding…'
            : sourceIds.has(folder.id)
              ? `Re-sync “${folder.name}” to knowledge base`
              : `Add “${folder.name}” to knowledge base`}
        </button>
      )}

      {error && <span className="err">{error}</span>}

      <div className="drive-list">
        {files.map((f) => (
          <div key={f.id} className={`drive-row ${f.isFolder ? 'folder' : ''}`}>
            {f.isFolder ? (
              <div className="drive-name folder-name">
                <input
                  type="checkbox"
                  aria-label={`Select folder ${f.name}`}
                  checked={selectedFolders.has(f.id)}
                  onChange={() => toggleFolder(f.id)}
                />
                <button className="folder-open" type="button" onClick={() => openFolder(f)}>
                  <span className="ic" aria-hidden="true">{fileIcon(f)}</span>
                  {f.name}
                </button>
              </div>
            ) : (
              <label className={`drive-name ${f.ingestable ? '' : 'muted'}`}>
                <input
                  type="checkbox"
                  disabled={!f.ingestable}
                  checked={selected.has(f.id)}
                  onChange={() => toggle(f.id)}
                />
                <span className="ic" aria-hidden="true">{fileIcon(f)}</span>
                {f.name}
                {!f.ingestable && <span className="tag-muted">not supported</span>}
              </label>
            )}
            {f.isFolder ? (
              <button
                className="linklike add-inline"
                type="button"
                disabled={busyFolder === f.id}
                onClick={() => addFolder(f.id)}
              >
                {busyFolder === f.id ? 'Adding…' : sourceIds.has(f.id) ? '✓ added · re-sync' : '+ Add to KB'}
              </button>
            ) : (
              <span className="drive-meta">{fmtSize(f.size)}</span>
            )}
          </div>
        ))}
        {!loading && files.length === 0 && (
          <p className="how">
            {searchMode
              ? 'No matches. Try a different name.'
              : hasBrowsed
                ? 'This folder is empty.'
                : 'Search above to find folders in your Drive (including shared folders). Tick folders to add several at once, or open one to look inside.'}
          </p>
        )}
        {loading && <p className="how">Loading…</p>}
      </div>

      <div className="drive-actions">
        {nextPageToken && (
          <button
            className="btn ghost"
            type="button"
            disabled={loading}
            onClick={() => loadFolder(folder.id, true, nextPageToken)}
          >
            Load more
          </button>
        )}
        {selectedFolders.size > 0 && (
          <button className="btn" type="button" disabled={ingesting} onClick={addSelectedFolders}>
            {ingesting
              ? 'Adding…'
              : `Add ${selectedFolders.size} folder${selectedFolders.size === 1 ? '' : 's'} to KB`}
          </button>
        )}
        <button className="btn" type="button" disabled={!selected.size || ingesting} onClick={ingestSelected}>
          {ingesting ? 'Ingesting…' : `Ingest selected${selected.size ? ` (${selected.size})` : ''}`}
        </button>
      </div>

      {folderSummary && (
        <div className="folder-summary">
          <b>{folderSummary.name}</b>: {folderSummary.filesFound} supported file
          {folderSummary.filesFound === 1 ? '' : 's'} found · {folderSummary.ingested} ingested
          {folderSummary.skipped ? ` · ${folderSummary.skipped} skipped` : ''}
          {folderSummary.failed ? ` · ${folderSummary.failed} failed` : ''}.
        </div>
      )}

      {results && (
        <div className="ingest-results">
          {results.map((r) => (
            <div key={r.fileId} className={`pill ${r.status === 'ingested' ? 'green' : 'amber'}`}>
              {r.name}: {r.status}
              {r.status === 'ingested' ? ` · ${r.chunks} chunks` : r.reason ? ` · ${r.reason}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
