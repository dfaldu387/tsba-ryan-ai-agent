import { useEffect, useMemo, useRef, useState } from 'react';
import type { Draft } from '@tsba/shared';
import { AuthError, getSolarAlerts, listDrafts, type SolarMonitorAlert } from '../api';

const ALERTS_SHOWN = 25; // max plant rows rendered in the notification panel

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
const SEEN_ALERTS_KEY = 'tsba.notifications.seenAlerts';

function loadSeenCount(): number {
  try {
    const n = Number(localStorage.getItem(SEEN_KEY));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function loadSeenAlerts(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_ALERTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set<string>(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set<string>();
  }
}

const SEVERITY_LABEL: Record<SolarMonitorAlert['severity'], string> = {
  offline: 'Plant offline',
  partial: 'Plant issue',
  fault: 'Plant fault',
  alert: 'Active fault',
  device: 'Device offline',
};

export function NotificationBell({
  onNavigate,
  onAuthError,
}: {
  onNavigate: (section: 'drafts' | 'solar') => void;
  onAuthError: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [alerts, setAlerts] = useState<SolarMonitorAlert[]>([]);
  const [seenCount, setSeenCount] = useState<number>(loadSeenCount);
  const [seenAlerts, setSeenAlerts] = useState<Set<string>>(loadSeenAlerts);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = () => {
    listDrafts()
      .then(setDrafts)
      .catch((err) => {
        if (err instanceof AuthError) onAuthError();
      });
    // Monitoring alerts are best-effort — a solar-platform hiccup must never
    // break the (more important) approvals panel.
    getSolarAlerts()
      .then((r) => setAlerts(r.alerts))
      .catch(() => {});
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

  // Collapse the raw scan (many rows per plant: plant-level + each device + each
  // fault) to ONE row per plant — its most-severe issue — with the plant's total
  // issue count and most-recent alert time. Keeps the panel readable.
  const plantGroups = useMemo(() => {
    const m = new Map<string, { rep: SolarMonitorAlert; count: number; latestAt?: number }>();
    for (const a of alerts) {
      const k = `${a.provider}:${a.plantId}`;
      const e = m.get(k);
      // `alerts` arrives most-severe first, so the first row per plant is its rep.
      if (e) {
        e.count++;
        if (a.at && (e.latestAt == null || a.at > e.latestAt)) e.latestAt = a.at;
      } else {
        m.set(k, { rep: a, count: 1, latestAt: a.at });
      }
    }
    return [...m.values()];
  }, [alerts]);

  const pending = drafts.filter((d) => d.status === 'pending');
  const recent = drafts
    .filter((d) => d.status !== 'pending' && d.decided_at)
    .sort((a, b) => (b.decided_at ?? '').localeCompare(a.decided_at ?? ''))
    .slice(0, 5);

  // Badge counts pending approvals + affected plants the user hasn't yet
  // acknowledged by opening the panel. Plants are tracked by key (their set
  // changes as issues resolve/appear), drafts by count.
  const plantKey = (a: SolarMonitorAlert) => `${a.provider}:${a.plantId}`;
  const unreadAlerts = plantGroups.filter((g) => !seenAlerts.has(plantKey(g.rep))).length;
  const unread = Math.max(0, pending.length - seenCount) + unreadAlerts;

  const markSeen = () => {
    setSeenCount(pending.length);
    const ids = plantGroups.map((g) => plantKey(g.rep));
    setSeenAlerts(new Set(ids));
    try {
      localStorage.setItem(SEEN_KEY, String(pending.length));
      localStorage.setItem(SEEN_ALERTS_KEY, JSON.stringify(ids));
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

            {plantGroups.length > 0 && (
              <>
                <div className="notif-section-title">Monitoring alerts ({plantGroups.length} plants)</div>
                <div className="notif-scroll">
                  {plantGroups.slice(0, ALERTS_SHOWN).map(({ rep: a, count, latestAt }) => (
                    <button
                      key={plantKey(a)}
                      type="button"
                      className="notif-item"
                      role="menuitem"
                      title={count > 1 ? `${count} issues on this plant` : undefined}
                      onClick={() => {
                        onNavigate('solar');
                        setOpen(false);
                      }}
                    >
                      <span className={`notif-dot alert-${a.severity}`} aria-hidden="true" />
                      <span className="notif-item-body">
                        <span className="notif-item-q">
                          {a.plant}
                          {count > 1 && <span className="notif-count">{count}</span>}
                        </span>
                        <span className="notif-item-meta">
                          {SEVERITY_LABEL[a.severity]} · {a.provider}
                          {latestAt ? ` · ${relativeTime(new Date(latestAt * 1000).toISOString())}` : ''}
                        </span>
                      </span>
                    </button>
                  ))}
                  {plantGroups.length > ALERTS_SHOWN && (
                    <button
                      type="button"
                      className="notif-item static notif-more"
                      onClick={() => {
                        onNavigate('solar');
                        setOpen(false);
                      }}
                    >
                      +{plantGroups.length - ALERTS_SHOWN} more — open Solar monitoring
                    </button>
                  )}
                </div>
              </>
            )}

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
                    onNavigate('drafts');
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
