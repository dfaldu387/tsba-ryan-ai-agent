import { useEffect, useState } from 'react';
import { AuthError, getProgress } from '../api';
import type { ProgressBoard, ProgressState } from '../types';

const MARK: Record<ProgressState, string> = {
  done: '✅',
  in_progress: '🔄',
  next: '⏳',
};

export function ProgressTab({ onAuthError }: { onAuthError: () => void }) {
  const [board, setBoard] = useState<ProgressBoard | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getProgress()
      .then(setBoard)
      .catch((err) => {
        if (err instanceof AuthError) return onAuthError();
        setError('Couldn’t load progress.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="wrap" style={{ gridTemplateColumns: '1fr', maxWidth: 860 }}>
      <div className="col">
        <section className="card">
          <div className="card-h">
            <h2>Build progress</h2>
            <span className="eyebrow">Last updated: {board?.lastUpdated ?? '…'}</span>
          </div>
          <p className="how" style={{ margin: 0 }}>
            A quick glance at what&rsquo;s done, what&rsquo;s in progress and what&rsquo;s next. Updated every few days.
          </p>
          <div className="p-legend">
            <span>{MARK.done} Done</span>
            <span>{MARK.in_progress} In progress</span>
            <span>{MARK.next} Next</span>
          </div>

          {error && <span className="err">{error}</span>}

          <div className="progress-list">
            {board?.items.map((item, i) => (
              <div key={i} className={`p-item ${item.state}`}>
                <span className="mark" aria-hidden="true">{MARK[item.state]}</span>
                <span className="ptext">{item.text}</span>
              </div>
            ))}
          </div>

          {board && (
            <p>
              <a className="sheet-link" href={board.sheet.url} target="_blank" rel="noreferrer noopener">
                → {board.sheet.label}
              </a>
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
