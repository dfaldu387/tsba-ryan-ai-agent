import { useEffect, useRef, useState } from 'react';
import type { Draft } from '@tsba/shared';
import { AuthError, listDrafts } from '../api';

// A header notification panel: surfaces replies awaiting approval (and recent
// activity) so an admin sees what needs attention without opening every tab.
// Polls the drafts endpoint on a light interval; clicking an item jumps to the
// approval queue.

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

const POLL_MS = 30_000;
const SEEN_KEY = 'tsba.notifications.seen';

function loadSeenCount(): number {
  try {
    const n = Number(localStorage.getItem(SEEN_KEY));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function NotificationBell({
  onNavigate,
  onAuthError,
}: {
  onNavigate: () => void;
  onAuthError: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [seenCount, setSeenCount] = useState<number>(loadSeenCount);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = () => {
    listDrafts()
      .then(setDrafts)
      .catch((err) => {
        if (err instanceof AuthError) onAuthError();
      });
  };

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const pending = drafts.filter((d) => d.status === 'pending');
  const recent = drafts
    .filter((d) => d.status !== 'pending' && d.decided_at)
    .sort((a, b) => (b.decided_at ?? '').localeCompare(a.decided_at ?? ''))
    .slice(0, 5);

  // Badge counts pending items the user hasn't acknowledged by opening the panel.
  const unread = Math.max(0, pending.length - seenCount);

  const markSeen = () => {
    setSeenCount(pending.length);
    try {
      localStorage.setItem(SEEN_KEY, String(pending.length));
    } catch {
      /* ignore */
    }
  };

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (next) markSeen();
      return next;
    });
  };

  const statusLabel: Record<string, string> = {
    sent: 'Sent',
    team: 'Sent to team',
    rejected: 'Rejected',
  };

  return (
    <div className="notif">
      <button
        type="button"
        className={`notif-trigger ${open ? 'open' : ''}`}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} new` : 'Notifications'}
        title="Notifications"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
          strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <>
          <button type="button" className="menu-backdrop" aria-label="Close notifications" onClick={() => setOpen(false)} />
          <div className="notif-panel" role="menu">
            <div className="notif-head">
              <span>Notifications</span>
              <button type="button" className="notif-refresh" onClick={refresh} title="Refresh">
                ↻
              </button>
            </div>

            <div className="notif-section-title">Awaiting approval ({pending.length})</div>
            {pending.length === 0 ? (
              <p className="notif-empty">Nothing waiting — you&rsquo;re all caught up.</p>
            ) : (
              pending.slice(0, 8).map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="notif-item"
                  role="menuitem"
                  onClick={() => {
                    onNavigate();
                    setOpen(false);
                  }}
                >
                  <span className="notif-dot" aria-hidden="true" />
                  <span className="notif-item-body">
                    <span className="notif-item-q">{d.question}</span>
                    <span className="notif-item-meta">
                      {d.audience} · {relativeTime(d.created_at)}
                    </span>
                  </span>
                </button>
              ))
            )}

            {recent.length > 0 && (
              <>
                <div className="notif-section-title">Recent activity</div>
                {recent.map((d) => (
                  <div key={d.id} className="notif-item static">
                    <span className={`notif-dot ${d.status}`} aria-hidden="true" />
                    <span className="notif-item-body">
                      <span className="notif-item-q">{d.question}</span>
                      <span className="notif-item-meta">
                        {statusLabel[d.status] ?? d.status} · {relativeTime(d.decided_at ?? d.created_at)}
                      </span>
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
