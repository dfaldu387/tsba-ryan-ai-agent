import { useEffect, useState } from 'react';
import type { Draft } from '@tsba/shared';
import { AuthError, listDrafts, patchDraft } from '../api';

// An interactive in-chat card: lists replies awaiting approval and lets the
// operator Approve, Send-to-team, or Reject each one inline. Reuses the existing
// drafts API, so an approval here triggers the same delivery pipeline as the
// Ask-the-agent tab.

type Busy = Record<number, 'approve' | 'team' | 'reject' | undefined>;

export function ApprovalCard({ onAuthError }: { onAuthError: () => void }) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [busy, setBusy] = useState<Busy>({});
  const [done, setDone] = useState<Record<number, string>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    listDrafts()
      .then((list) => alive && setDrafts(list))
      .catch((err) => {
        if (err instanceof AuthError) return onAuthError();
        if (alive) setError('Couldn’t load the approval queue.');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pending = (drafts ?? []).filter((d) => d.status === 'pending');

  async function act(d: Draft, action: 'approve' | 'reject') {
    const kind = action === 'approve' ? (d.outcome === 'handover' ? 'team' : 'approve') : 'reject';
    setBusy((b) => ({ ...b, [d.id]: kind }));
    setError('');
    try {
      const updated = await patchDraft(d.id, { action });
      setDone((s) => ({
        ...s,
        [d.id]:
          updated.status === 'sent'
            ? 'Approved & sent'
            : updated.status === 'team'
              ? 'Sent to team'
              : 'Rejected',
      }));
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      setError('That action didn’t go through — please try again.');
    } finally {
      setBusy((b) => ({ ...b, [d.id]: undefined }));
    }
  }

  if (drafts === null) {
    return (
      <div className="jcard">
        <div className="thinking">
          <span className="spin" aria-hidden="true" />
          <span>Checking the approval queue…</span>
        </div>
      </div>
    );
  }

  if (pending.length === 0) {
    return (
      <div className="jcard">
        <p className="jreply">Nothing is waiting on you right now — the approval queue is clear. ✅</p>
      </div>
    );
  }

  return (
    <div className="jcard">
      <div className="jcard-head">
        <span className="jcard-title">Replies awaiting approval</span>
        <span className="jcard-count">{pending.length}</span>
      </div>

      <div className="jtasks">
        {pending.slice(0, 8).map((d) => {
          const finished = done[d.id];
          return (
            <div key={d.id} className={`jtask ${finished ? 'resolved' : ''}`}>
              <div className="jtask-body">
                <span className="jtask-title">{d.question}</span>
                <span className="jtask-meta">
                  {d.audience} · {d.channel}
                  {d.outcome === 'handover' ? ' · needs team' : ''}
                  {d.recipient ? ` · ${d.recipient}` : ''}
                </span>
              </div>
              {finished ? (
                <span className="jtask-done">✓ {finished}</span>
              ) : (
                <div className="jtask-actions">
                  <button
                    type="button"
                    className="jtask-btn ok"
                    onClick={() => void act(d, 'approve')}
                    disabled={Boolean(busy[d.id])}
                  >
                    {busy[d.id] === 'approve' || busy[d.id] === 'team'
                      ? '…'
                      : d.outcome === 'handover'
                        ? 'Send to team'
                        : 'Approve'}
                  </button>
                  <button
                    type="button"
                    className="jtask-btn danger"
                    onClick={() => void act(d, 'reject')}
                    disabled={Boolean(busy[d.id])}
                  >
                    {busy[d.id] === 'reject' ? '…' : 'Reject'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {pending.length > 8 && (
        <p className="jtask-more">+{pending.length - 8} more in the approval queue</p>
      )}
      {error && <span className="err" role="status">{error}</span>}
    </div>
  );
}
