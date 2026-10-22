import { useEffect, useState } from 'react';
import type { GmailLabel, GmailScanResult } from '@tsba/shared';
import { ApiError, AuthError, listGmailLabels, scanGmailLabel } from '../api';

// Shown under a connected Gmail connector (for users who can run ingest).
// Pick a label, scan its messages into the knowledge base (RAG training data).
export function GmailScanner({ onAuthError }: { onAuthError: () => void }) {
  const [labels, setLabels] = useState<GmailLabel[] | null>(null);
  const [labelId, setLabelId] = useState('');
  const [max, setMax] = useState(200);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<GmailScanResult | null>(null);

  const handle = (err: unknown, fallback: string) => {
    if (err instanceof AuthError) return onAuthError();
    setError(err instanceof ApiError ? err.message || fallback : fallback);
  };

  useEffect(() => {
    listGmailLabels()
      .then((r) => {
        setLabels(r.labels);
        const support = r.labels.find((l) => /support|help|service/i.test(l.name));
        setLabelId(support?.id ?? r.labels[0]?.id ?? '');
      })
      .catch((err) => handle(err, 'Couldn’t load Gmail labels.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function scan() {
    if (!labelId) return;
    setScanning(true);
    setError('');
    setResult(null);
    try {
      setResult(await scanGmailLabel(labelId, max));
    } catch (err) {
      handle(err, 'The scan failed.');
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="gmail-scanner">
      <div className="card-h">
        <h3>Scan email into the knowledge base</h3>
        <span className="eyebrow">Gmail → RAG</span>
      </div>
      <p className="how" style={{ marginTop: 0 }}>
        Pick a label and scan its messages. Each email is extracted, chunked and embedded so the
        agent can draw on it — nothing is ever sent from here.
      </p>

      <div className="drive-bar">
        <label className="field" style={{ flex: '1 1 220px' }}>
          <span className="eyebrow">Label</span>
          <select value={labelId} onChange={(e) => setLabelId(e.target.value)} disabled={!labels}>
            {labels?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.type === 'system' ? ' (system)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: '0 0 120px' }}>
          <span className="eyebrow">Max messages</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={max}
            onChange={(e) => setMax(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))}
          />
        </label>
        <button className="btn" onClick={scan} disabled={scanning || !labelId}>
          {scanning ? 'Scanning…' : 'Scan label'}
        </button>
      </div>

      {error && <span className="err">{error}</span>}

      {result && (
        <div className="folder-summary">
          <b>{result.labelName}</b>: {result.messagesFound} messages found · {result.ingested} ingested ·{' '}
          {result.skipped} skipped · {result.failed} failed
        </div>
      )}
    </div>
  );
}
