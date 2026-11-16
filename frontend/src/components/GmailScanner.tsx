import { useEffect, useRef, useState } from 'react';
import type { GmailLabel, GmailScanResult } from '@tsba/shared';
import { ApiError, AuthError, listGmailLabels, scanGmailLabel } from '../api';
import { Icon } from '../ui';
import { fmtInt } from '../lib/format';
import './knowledge.css';

// Rough per-message cost of a scan (fetch + extract + chunk + embed). Only used
// to give the operator a ballpark before/while a scan runs — always shown as an
// estimate, never as a promise.
const EST_SECONDS_PER_MESSAGE = 1.2;

function fmtDuration(sec: number): string {
  if (sec < 60) return 'under a minute';
  const min = Math.round(sec / 60);
  if (min < 60) return `about ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `about ${h} h${m ? ` ${m} min` : ''}`;
}

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Pick a Gmail label and scan its messages into the knowledge base (RAG training
// data). Used inside the Knowledge base "Scan Gmail" drawer and under the Gmail
// connector in Connections.
export function GmailScanner({
  onAuthError,
  onScanned,
  onRunningChange,
}: {
  onAuthError: () => void;
  /** Called after a scan finishes successfully (e.g. to refresh a document list). */
  onScanned?: (result: GmailScanResult) => void;
  /** Notified when a scan starts / stops (e.g. to guard closing a drawer). */
  onRunningChange?: (running: boolean) => void;
}) {
  const [labels, setLabels] = useState<GmailLabel[] | null>(null);
  const [labelId, setLabelId] = useState('');
  const [max, setMax] = useState(200);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<GmailScanResult | null>(null);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

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

  // Elapsed-time ticker while a scan runs.
  useEffect(() => {
    if (startedAt == null) return;
    const t = window.setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 1000);
    return () => window.clearInterval(t);
  }, [startedAt]);

  const label = labels?.find((l) => l.id === labelId);
  const expected = label?.messagesTotal != null ? Math.min(max, label.messagesTotal) : max;
  const estSeconds = expected * EST_SECONDS_PER_MESSAGE;

  async function scan() {
    if (!labelId) return;
    setScanning(true);
    onRunningChange?.(true);
    setStartedAt(Date.now());
    setElapsed(0);
    setError('');
    setResult(null);
    try {
      const r = await scanGmailLabel(labelId, max);
      onScanned?.(r); // parent callback fires even if this panel was closed mid-scan
      if (mounted.current) setResult(r);
    } catch (err) {
      if (mounted.current) handle(err, 'The scan failed.');
    } finally {
      if (mounted.current) {
        setScanning(false);
        setStartedAt(null);
      }
      onRunningChange?.(false);
    }
  }

  return (
    <div className="kb-gs">
      <p className="kb-gs-intro">
        Pick a label and scan its messages. Each email is extracted, chunked and embedded so the agent can
        draw on it. Nothing is ever sent from here.
      </p>

      <div className="kb-gs-form">
        <label className="kb-gs-field">
          <span>Label</span>
          <select className="c-select" value={labelId} onChange={(e) => setLabelId(e.target.value)} disabled={!labels || scanning}>
            {!labels && <option>Loading labels…</option>}
            {labels?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.type === 'system' ? ' (system)' : ''}
                {l.messagesTotal != null ? ` · ${fmtInt(l.messagesTotal)}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="kb-gs-field">
          <span>Max messages</span>
          <input
            className="c-input"
            type="number"
            min={1}
            max={1000}
            value={max}
            disabled={scanning}
            onChange={(e) => setMax(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))}
          />
        </label>
      </div>

      {labelId && !result && (
        <div className="kb-gs-est">
          <Icon name="clock" size={16} />
          <span>
            <strong>≈ {fmtInt(expected)} messages</strong>, {fmtDuration(estSeconds)}{' '}
            <span className="c-muted">(estimate{label?.messagesTotal == null ? ', label size unknown' : ''})</span>
          </span>
        </div>
      )}

      {scanning && (
        <div className="kb-gs-run" role="status" aria-live="polite">
          <div className="kb-gs-run-top">
            <strong>Scanning {label?.name ?? 'label'}…</strong>
            <span className="kb-gs-elapsed">
              {fmtClock(elapsed)} elapsed · est. {fmtDuration(estSeconds).replace('about ', '~')}
            </span>
          </div>
          <div className="kb-progress" role="progressbar" aria-label="Scanning Gmail label" aria-valuetext={`${Math.round(elapsed)} seconds elapsed`} />
          <span className="c-muted" style={{ fontSize: 12.5 }}>
            You can close this panel — the scan keeps running on the server.
          </span>
        </div>
      )}

      {error && (
        <div className="c-banner t-danger" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div aria-live="polite">
          <p style={{ marginBottom: 8, fontSize: 13.5 }}>
            <strong>{result.labelName}</strong> scanned.
          </p>
          <div className="kb-gs-result">
            <div><strong>{fmtInt(result.messagesFound)}</strong><span>found</span></div>
            <div><strong>{fmtInt(result.ingested)}</strong><span>ingested</span></div>
            <div><strong>{fmtInt(result.skipped)}</strong><span>skipped</span></div>
            <div><strong>{fmtInt(result.failed)}</strong><span>failed</span></div>
          </div>
        </div>
      )}

      <div className="kb-gs-acts">
        <button type="button" className="c-btn primary" onClick={scan} disabled={scanning || !labelId}>
          <Icon name="mail" size={16} />
          {scanning ? 'Scanning…' : result ? 'Scan again' : 'Scan label'}
        </button>
      </div>
    </div>
  );
}
