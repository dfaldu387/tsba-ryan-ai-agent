import { useEffect, useMemo, useRef, useState } from 'react';
import { getAlertSolution } from '../api';
import { useConsole } from '../lib/console';
import { isSnoozed, type AlertGroup, type Severity } from '../lib/alerts';
import { Icon } from '../ui';
import './notification-bell.css';

/**
 * Header notification centre. Monitoring alerts are grouped by PLANT (one card
 * per plant, most urgent first) and split into New / Earlier by what this
 * person has read. Each card expands to its faults with the fault code, how long
 * it has been open, a suggested fix on demand, and team-wide triage actions
 * (acknowledge / snooze — shared via the server, so everyone sees the same
 * state). Drafts awaiting approval have their own filter.
 *
 * Reads the console's shared, already-polled data (no polling of its own).
 * Read/unread is personal and stays in this browser.
 */

type Filter = 'all' | 'offline' | 'faults' | 'devices' | 'approvals' | 'handled';

const READ_KEY = 'tsba.notif.read.v2';
const SEV_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const SNOOZE_OPTIONS: { label: string; hours: number }[] = [
  { label: '1 hour', hours: 1 },
  { label: '4 hours', hours: 4 },
  { label: 'Until tomorrow', hours: 24 },
  { label: '1 week', hours: 168 },
];

function loadRead(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(READ_KEY) ?? '[]');
    return new Set<string>(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function saveRead(s: Set<string>): void {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

function ago(ms: number | null | undefined): string {
  if (!ms) return '';
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} h`;
  return `${Math.round(hrs / 24)} d`;
}

/** Which filter bucket a fault group belongs to. */
function bucket(g: AlertGroup): 'offline' | 'faults' | 'devices' {
  if (g.category === 'offline' || g.category === 'partial') return 'offline';
  if (g.fault === 'Device not communicating') return 'devices';
  return 'faults';
}

interface PlantCard {
  key: string; // provider:plantId
  provider: string;
  plantId: string;
  plant: string;
  severity: Severity;
  groups: AlertGroup[];
  since: number | null;
  unread: boolean;
}

export function NotificationBell() {
  const {
    groups, triage, setTriage, drafts, openPlant, navigate, providerName, toast,
    alertsLoading, refreshFleet, refreshDrafts, lastUpdated,
  } = useConsole();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [read, setRead] = useState<Set<string>>(loadRead);
  const [fixes, setFixes] = useState<Record<string, { loading?: boolean; text?: string | null; source?: string | null; error?: string }>>({});
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  // Plants that were unread when the panel opened. The New / Earlier split uses
  // this snapshot so a card doesn't jump to "Earlier" the moment you open it.
  const [newAtOpen, setNewAtOpen] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on Escape, return focus to the bell.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (snoozeFor) setSnoozeFor(null);
        else {
          setOpen(false);
          triggerRef.current?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, snoozeFor]);

  const now = Date.now();
  const handled = (g: AlertGroup) => Boolean(triage[g.key]?.ack) || isSnoozed(triage[g.key], now);

  // Plant cards from the open (not acknowledged / snoozed) groups, or from the
  // handled ones when that filter is on.
  const cards = useMemo(() => {
    const want = (g: AlertGroup) => {
      if (filter === 'handled') return handled(g);
      if (handled(g)) return false;
      if (filter === 'all' || filter === 'approvals') return true;
      return bucket(g) === filter;
    };
    const m = new Map<string, PlantCard>();
    for (const g of groups) {
      if (!want(g)) continue;
      const k = `${g.provider}:${g.plantId}`;
      let c = m.get(k);
      if (!c) {
        c = { key: k, provider: g.provider, plantId: g.plantId, plant: g.plant, severity: g.severity, groups: [], since: null, unread: false };
        m.set(k, c);
      }
      c.groups.push(g);
      if (SEV_RANK[g.severity] < SEV_RANK[c.severity]) c.severity = g.severity;
      if (g.since != null) c.since = c.since == null ? g.since : Math.min(c.since, g.since);
      if (!read.has(g.key)) c.unread = true;
    }
    for (const c of m.values()) c.groups.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
    // Most urgent first; within a severity, the most recent problem first.
    return [...m.values()].sort(
      (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || (b.since ?? 0) - (a.since ?? 0) || a.plant.localeCompare(b.plant),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, triage, filter, read]);

  // Counts for the filter chips (open, unhandled groups → plants).
  const counts = useMemo(() => {
    const plants = { all: new Set<string>(), offline: new Set<string>(), faults: new Set<string>(), devices: new Set<string>(), handled: new Set<string>() };
    for (const g of groups) {
      const k = `${g.provider}:${g.plantId}`;
      if (handled(g)) {
        plants.handled.add(k);
        continue;
      }
      plants.all.add(k);
      plants[bucket(g)].add(k);
    }
    return { all: plants.all.size, offline: plants.offline.size, faults: plants.faults.size, devices: plants.devices.size, handled: plants.handled.size };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, triage]);

  const pending = (drafts ?? []).filter((d) => d.status === 'pending');
  const unreadDrafts = pending.filter((d) => !read.has(`draft:${d.id}`)).length;

  // Badge: plants with something unread and unhandled + unread approvals.
  const unreadPlants = useMemo(() => {
    const s = new Set<string>();
    let critical = false;
    for (const g of groups) {
      if (handled(g) || read.has(g.key)) continue;
      s.add(`${g.provider}:${g.plantId}`);
      if (g.severity === 'critical') critical = true;
    }
    return { count: s.size, critical };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, triage, read]);
  const badge = unreadPlants.count + unreadDrafts;

  const markRead = (keys: string[]) => {
    setRead((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.add(k));
      // Keep only keys that still exist, so the store doesn't grow forever.
      const live = new Set([...groups.map((g) => g.key), ...pending.map((d) => `draft:${d.id}`)]);
      for (const k of next) if (!live.has(k)) next.delete(k);
      saveRead(next);
      return next;
    });
  };
  const markAllRead = () => markRead([...groups.map((g) => g.key), ...pending.map((d) => `draft:${d.id}`)]);

  const toggleCard = (c: PlantCard) => {
    setExpanded((e) => (e === c.key ? null : c.key));
    markRead(c.groups.map((g) => g.key));
  };

  const loadFix = (g: AlertGroup) => {
    if (fixes[g.key]?.loading) return;
    if (g.solution) {
      setFixes((f) => ({ ...f, [g.key]: { text: g.solution, source: 'provider' } }));
      return;
    }
    setFixes((f) => ({ ...f, [g.key]: { loading: true } }));
    getAlertSolution(g.items.map((i) => i.id))
      .then((r) => setFixes((f) => ({ ...f, [g.key]: { text: r.solution, source: r.source } })))
      .catch((err: Error) => setFixes((f) => ({ ...f, [g.key]: { error: err.message || 'Couldn’t get a suggestion right now.' } })));
  };

  const acknowledge = (gs: AlertGroup[], label: string) => {
    gs.forEach((g) => setTriage(g.key, { ack: Date.now(), snoozeUntil: undefined }));
    markRead(gs.map((g) => g.key));
    toast({
      text: `Acknowledged ${label}`,
      tone: 'success',
      action: { label: 'Undo', run: () => gs.forEach((g) => setTriage(g.key, { ack: undefined })) },
    });
  };
  const snooze = (gs: AlertGroup[], hours: number, label: string) => {
    gs.forEach((g) => setTriage(g.key, { snoozeUntil: Date.now() + hours * 3_600_000 }));
    markRead(gs.map((g) => g.key));
    setSnoozeFor(null);
    toast({
      text: `Snoozed ${label} for ${hours >= 24 ? `${Math.round(hours / 24)} day${hours >= 48 ? 's' : ''}` : `${hours} h`}`,
      action: { label: 'Undo', run: () => gs.forEach((g) => setTriage(g.key, { snoozeUntil: undefined })) },
    });
  };
  const reopen = (gs: AlertGroup[]) => gs.forEach((g) => setTriage(g.key, { ack: undefined, snoozeUntil: undefined }));

  const seenAtOpen = useRef<Set<string>>(new Set());
  const toggleOpen = () => {
    if (!open) {
      // Snapshot which plants are unread (→ New) and which were known (→ not new).
      const unread = new Set<string>();
      const known = new Set<string>();
      for (const g of groups) {
        const k = `${g.provider}:${g.plantId}`;
        known.add(k);
        if (!read.has(g.key)) unread.add(k);
      }
      for (const k of unread) known.delete(k);
      setNewAtOpen(unread);
      seenAtOpen.current = known;
    }
    setOpen((o) => !o);
  };

  const close = () => {
    setOpen(false);
    setSnoozeFor(null);
  };
  const goPlant = (c: PlantCard, tab?: string) => {
    openPlant({ provider: c.provider, id: c.plantId }, tab ? { tab } : undefined);
    close();
  };

  // New = unread when the panel opened, or arrived while it is open.
  const isNew = (c: PlantCard) => newAtOpen.has(c.key) || (c.unread && !seenAtOpen.current.has(c.key));
  const newCards = filter === 'handled' ? [] : cards.filter(isNew);
  const earlierCards = filter === 'handled' ? cards : cards.filter((c) => !isNew(c));

  const FILTERS: { id: Filter; label: string; n: number }[] = [
    { id: 'all', label: 'All', n: counts.all + pending.length },
    { id: 'offline', label: 'Offline', n: counts.offline },
    { id: 'faults', label: 'Faults', n: counts.faults },
    { id: 'devices', label: 'Devices', n: counts.devices },
    { id: 'approvals', label: 'Approvals', n: pending.length },
    { id: 'handled', label: 'Handled', n: counts.handled },
  ];

  const renderCard = (c: PlantCard) => {
    const isOpen = expanded === c.key;
    const label = c.groups.length === 1 ? c.groups[0].fault : `${c.groups.length} issues`;
    return (
      <li key={c.key} className={`nb-card sev-${c.severity}${isOpen ? ' is-open' : ''}`}>
        <button type="button" className="nb-card-h" onClick={() => toggleCard(c)} aria-expanded={isOpen}>
          <span className="nb-sev" aria-hidden="true" />
          <span className="nb-card-main">
            <span className="nb-card-title">
              {c.unread && <span className="nb-unread" aria-label="Unread" />}
              <span className="nb-plant">{c.plant}</span>
            </span>
            <span className="nb-card-sub">
              <span className={`nb-tag sev-${c.severity}`}>{label}</span>
              <span>{providerName(c.provider)}</span>
              {c.since && <span>· open {ago(c.since)}</span>}
            </span>
          </span>
          <Icon name="chevronDown" size={16} className="nb-chev" />
        </button>

        {isOpen && (
          <div className="nb-card-body">
            <ul className="nb-faults">
              {c.groups.map((g) => {
                const fix = fixes[g.key];
                const t = triage[g.key];
                return (
                  <li key={g.key} className={`nb-fault sev-${g.severity}`}>
                    <div className="nb-fault-h">
                      <span className="nb-fault-name">{g.fault}</span>
                      {g.code && <code className="nb-code">{g.code}</code>}
                    </div>
                    <div className="nb-fault-meta">
                      {g.since ? `Open ${ago(g.since)}` : 'Open'}
                      {g.devices.length > 0 && ` · ${g.devices.length === 1 ? g.devices[0] : `${g.devices.length} devices`}`}
                      {g.providerStatus && ` · ${g.providerStatus}`}
                    </div>
                    {filter === 'handled' && t && (
                      <div className="nb-fault-meta nb-handled">
                        {t.ack ? `Acknowledged${t.ackBy ? ` by ${t.ackBy}` : ''} ${ago(t.ack)} ago` : null}
                        {!t.ack && t.snoozeUntil ? `Snoozed${t.snoozedBy ? ` by ${t.snoozedBy}` : ''} until ${new Date(t.snoozeUntil).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : null}
                      </div>
                    )}

                    {fix && (
                      <div className="nb-fix" aria-live="polite">
                        {fix.loading && <span className="nb-fix-loading">Working out a fix…</span>}
                        {fix.error && <span className="nb-fix-err">{fix.error}</span>}
                        {!fix.loading && !fix.error && (
                          fix.text ? (
                            <>
                              <span className="nb-fix-label">
                                <Icon name="wrench" size={13} /> Suggested fix
                                <span className="nb-fix-src">{fix.source === 'provider' ? 'from the manufacturer' : 'AI · from your knowledge base'}</span>
                              </span>
                              <p className="nb-fix-text">{fix.text}</p>
                            </>
                          ) : (
                            <span className="nb-fix-err">No suggestion available for this one.</span>
                          )
                        )}
                      </div>
                    )}

                    <div className="nb-actions">
                      {filter === 'handled' ? (
                        <button type="button" className="nb-btn" onClick={() => reopen([g])}>Re-open</button>
                      ) : (
                        <>
                          {!fix && (
                            <button type="button" className="nb-btn primary" onClick={() => loadFix(g)}>
                              <Icon name="wrench" size={13} /> Suggested fix
                            </button>
                          )}
                          <button type="button" className="nb-btn" onClick={() => acknowledge([g], g.fault)}>
                            <Icon name="check" size={13} /> Acknowledge
                          </button>
                          <span className="nb-snooze">
                            <button
                              type="button"
                              className="nb-btn"
                              aria-haspopup="menu"
                              aria-expanded={snoozeFor === g.key}
                              onClick={() => setSnoozeFor((s) => (s === g.key ? null : g.key))}
                            >
                              <Icon name="clock" size={13} /> Snooze
                            </button>
                            {snoozeFor === g.key && (
                              <span className="nb-snooze-menu" role="menu">
                                {SNOOZE_OPTIONS.map((o) => (
                                  <button key={o.hours} type="button" role="menuitem" onClick={() => snooze([g], o.hours, g.fault)}>
                                    {o.label}
                                  </button>
                                ))}
                              </span>
                            )}
                          </span>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="nb-card-foot">
              <button type="button" className="nb-link" onClick={() => goPlant(c, 'alerts')}>
                Open plant <Icon name="chevron" size={13} />
              </button>
              {filter !== 'handled' && c.groups.length > 1 && (
                <button type="button" className="nb-link muted" onClick={() => acknowledge(c.groups, `all ${c.groups.length} issues at ${c.plant}`)}>
                  Acknowledge all
                </button>
              )}
            </div>
          </div>
        )}
      </li>
    );
  };

  const showAlerts = filter !== 'approvals';
  const showApprovals = filter === 'all' || filter === 'approvals';

  return (
    <div className="nb">
      <button
        ref={triggerRef}
        type="button"
        className={`nb-trigger${open ? ' is-open' : ''}`}
        onClick={toggleOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={badge > 0 ? `Notifications, ${badge} unread` : 'Notifications'}
        title="Notifications"
      >
        <Icon name="bell" size={18} />
        {badge > 0 && <span className={`nb-badge${unreadPlants.critical ? ' crit' : ''}`}>{badge > 99 ? '99+' : badge}</span>}
      </button>

      {open && (
        <>
          <button type="button" className="nb-backdrop" aria-label="Close notifications" onClick={close} />
          <div className="nb-panel" role="dialog" aria-label="Notifications" ref={panelRef}>
            <header className="nb-head">
              <div>
                <h2>Notifications</h2>
                <p>
                  {alertsLoading && groups.length === 0
                    ? 'Checking the fleet…'
                    : counts.all
                      ? `${counts.all} plant${counts.all === 1 ? '' : 's'} need attention`
                      : 'No open plant issues'}
                  {lastUpdated ? ` · updated ${ago(lastUpdated) === 'just now' ? 'just now' : `${ago(lastUpdated)} ago`}` : ''}
                </p>
              </div>
              <div className="nb-head-actions">
                {badge > 0 && (
                  <button type="button" className="nb-link" onClick={markAllRead}>Mark all read</button>
                )}
                <button
                  type="button"
                  className="nb-icon"
                  onClick={() => {
                    void refreshFleet();
                    void refreshDrafts();
                  }}
                  title="Refresh"
                  aria-label="Refresh notifications"
                >
                  <Icon name="refresh" size={15} />
                </button>
              </div>
            </header>

            <div className="nb-filters" role="tablist" aria-label="Filter notifications">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  className={`nb-filter${filter === f.id ? ' on' : ''}`}
                  onClick={() => {
                    setFilter(f.id);
                    setExpanded(null);
                    setSnoozeFor(null);
                  }}
                >
                  {f.label}
                  <span className="nb-filter-n">{f.n}</span>
                </button>
              ))}
            </div>

            <div className="nb-scroll">
              {showAlerts && alertsLoading && groups.length === 0 && (
                <ul className="nb-list" aria-busy="true">
                  {[0, 1, 2].map((i) => <li key={i} className="nb-skel" />)}
                </ul>
              )}

              {showAlerts && !alertsLoading && cards.length === 0 && (
                <div className="nb-empty">
                  <Icon name="check" size={20} />
                  <strong>{filter === 'handled' ? 'Nothing acknowledged or snoozed' : 'All clear'}</strong>
                  <span>
                    {filter === 'handled'
                      ? 'Issues you acknowledge or snooze show here, with who did it.'
                      : filter === 'all'
                        ? 'No plant is offline or reporting a fault right now.'
                        : `No ${filter === 'offline' ? 'offline plants' : filter === 'faults' ? 'active faults' : 'offline devices'} right now.`}
                  </span>
                </div>
              )}

              {showAlerts && newCards.length > 0 && (
                <section>
                  <h3 className="nb-sec">New <span>{newCards.length}</span></h3>
                  <ul className="nb-list">{newCards.map(renderCard)}</ul>
                </section>
              )}
              {showAlerts && earlierCards.length > 0 && (
                <section>
                  {filter !== 'handled' && <h3 className="nb-sec">Earlier <span>{earlierCards.length}</span></h3>}
                  <ul className="nb-list">{earlierCards.map(renderCard)}</ul>
                </section>
              )}

              {showApprovals && (
                <section>
                  <h3 className="nb-sec">Awaiting approval <span>{pending.length}</span></h3>
                  {pending.length === 0 ? (
                    <p className="nb-muted">Nothing waiting — you’re all caught up.</p>
                  ) : (
                    <ul className="nb-list">
                      {pending.slice(0, filter === 'approvals' ? 50 : 5).map((d) => (
                        <li key={d.id}>
                          <button
                            type="button"
                            className="nb-draft"
                            onClick={() => {
                              markRead([`draft:${d.id}`]);
                              navigate('drafts');
                              close();
                            }}
                          >
                            {!read.has(`draft:${d.id}`) && <span className="nb-unread" aria-label="Unread" />}
                            <span className="nb-draft-q">{d.question}</span>
                            <span className="nb-draft-meta">{d.audience} · {ago(new Date(d.created_at).getTime())} ago</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </div>

            <footer className="nb-foot">
              <button
                type="button"
                className="nb-link"
                onClick={() => {
                  navigate('solar', '?view=alerts');
                  close();
                }}
              >
                View all alerts <Icon name="chevron" size={13} />
              </button>
              <button
                type="button"
                className="nb-link muted"
                onClick={() => {
                  navigate('settings');
                  close();
                }}
              >
                Alert settings
              </button>
            </footer>
          </div>
        </>
      )}
    </div>
  );
}
