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
  listDocuments,
  listFolderSources,
  reingestFlaggedDocuments,
  removeDocument,
  removeFolderSource,
  resyncAll,
  syncAllFolderSources,
  syncFolderSource,
} from '../api';

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

// Docs that aren't cleanly usable: garbled text, or no text at all (image-only
// PDFs marked skipped/failed). These are the ones an OCR re-ingest should retry.
const isFlagged = (d: IngestedDocument) =>
  d.source === 'google-drive' &&
  (d.text_quality === 'low' || d.text_quality === 'corrupted' || d.status === 'skipped' || d.status === 'failed');

export function KnowledgeTab({ user, onAuthError }: { user: AuthenticatedUser; onAuthError: () => void }) {
  const canIngest = hasPermission(user.role, 'run_ingest');
  const [docs, setDocs] = useState<IngestedDocument[] | null>(null);
  const [folders, setFolders] = useState<DriveFolderSource[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [reingesting, setReingesting] = useState(false);
  const [assessing, setAssessing] = useState(false);
  const [resyncing, setResyncing] = useState(false);

  const handle = (err: unknown, fallback: string) => {
    if (err instanceof AuthError) return onAuthError();
    setError(err instanceof ApiError ? err.message || fallback : fallback);
  };

  const load = () =>
    Promise.all([listDocuments(), listFolderSources()])
      .then(([d, f]) => {
        setDocs(d.documents);
        setFolders(f.folders);
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

  return (
    <div className="col">
      {error && <span className="err">{error}</span>}

      {/* ── Folder sources ───────────────────────────────────────────────── */}
      <section className="card">
        <div className="card-h">
          <h2>Drive folder sources</h2>
          <div className="drive-selall">
            <span className="eyebrow">{folders ? `${folders.length} folders` : '…'}</span>
            {canIngest && folders && folders.length > 0 && (
              <>
                <button className="btn ghost sm" type="button" disabled={syncingAll || resyncing} onClick={onSyncAll}>
                  {syncingAll ? 'Syncing all…' : 'Sync all'}
                </button>
                <button className="btn ghost sm danger" type="button" disabled={resyncing || syncingAll} onClick={onResyncAll}>
                  {resyncing ? 'Resetting…' : 'Reset & re-sync all'}
                </button>
              </>
            )}
          </div>
        </div>
        <p className="how" style={{ marginTop: 0 }}>
          Folders selected as knowledge sources. Add or manage them from <b>Connections → Google Drive</b>.
        </p>
        <div className="user-table">
          {folders?.map((f) => (
            <div key={f.id} className="user-row">
              <div className="user-row-main">
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
                    className="btn ghost sm"
                    disabled={busy === f.id || syncingAll}
                    onClick={() => onSync(f.id)}
                  >
                    {busy === f.id || syncingAll ? 'Syncing…' : 'Sync'}
                  </button>
                  <button
                    className="btn ghost sm danger"
                    disabled={busy === f.id || syncingAll}
                    onClick={() => onRemoveFolder(f.id)}
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          ))}
          {folders === null && !error && <p className="how">Loading…</p>}
          {folders?.length === 0 && <p className="how">No folder sources yet.</p>}
        </div>
      </section>

      {/* ── Ingested documents ───────────────────────────────────────────── */}
      <section className="card">
        <div className="card-h">
          <h2>Ingested documents</h2>
          <div className="drive-selall">
            <span className="eyebrow">
              {docs ? `${docs.length} total` : '…'}
              {docs && docs.some(isFlagged) ? ` · ${docs.filter(isFlagged).length} need OCR` : ''}
            </span>
            {canIngest && docs && docs.length > 0 && (
              <button className="btn ghost sm" type="button" disabled={assessing || reingesting} onClick={onAssess}>
                {assessing ? 'Checking…' : 'Check text quality'}
              </button>
            )}
            {canIngest && docs && docs.some(isFlagged) && (
              <button className="btn ghost sm" type="button" disabled={reingesting || assessing} onClick={onReingestFlagged}>
                {reingesting ? 'Re-ingesting…' : `Re-ingest ${docs.filter(isFlagged).length} flagged (OCR)`}
              </button>
            )}
          </div>
        </div>
        <div className="user-table">
          {docs?.map((d) => (
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
              {canIngest && (
                <div className="user-row-actions">
                  <button
                    className="btn ghost sm danger"
                    disabled={busy === d.id}
                    onClick={() => onRemoveDoc(d.id)}
                  >
                    {busy === d.id ? '…' : 'Remove'}
                  </button>
                </div>
              )}
            </div>
          ))}
          {docs === null && !error && <p className="how">Loading…</p>}
          {docs?.length === 0 && (
            <p className="how">
              Nothing ingested yet. Connect Google Drive or Gmail and scan content from{' '}
              <b>Connections</b>.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
