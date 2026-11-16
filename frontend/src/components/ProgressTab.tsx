import { useEffect, useState } from 'react';
import { AuthError, getProgress } from '../api';
import type { ProgressBoard, ProgressState } from '../types';
import { Icon, type IconName } from '../ui';

// The app's own icon set (was emoji, which rendered differently per OS and
// clashed with every other screen). Each state also has a spoken label.
const MARK: Record<ProgressState, { icon: IconName; label: string }> = {
  done: { icon: 'check', label: 'Done' },
  in_progress: { icon: 'refresh', label: 'In progress' },
  next: { icon: 'clock', label: 'Next' },
};
const Mark = ({ state }: { state: ProgressState }) => (
  <span className={`mark is-${state}`} aria-hidden="true"><Icon name={MARK[state].icon} size={14} /></span>
);

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
    // A div, not <main>: the app shell already provides the page's <main>.
    <div className="wrap" style={{ gridTemplateColumns: '1fr', maxWidth: 860 }}>
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
            {(['done', 'in_progress', 'next'] as ProgressState[]).map((st) => <span key={st}><Mark state={st} /> {MARK[st].label}</span>)}
          </div>

          {error && <span className="err">{error}</span>}

          <div className="progress-list">
            {board?.items.map((item, i) => (
              <div key={i} className={`p-item ${item.state}`}>
                <Mark state={item.state} />
                <span className="ptext"><span className="c-sr">{MARK[item.state].label}: </span>{item.text}</span>
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
    </div>
  );
}
