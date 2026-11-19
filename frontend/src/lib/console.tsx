// Console-wide shared state: fleet data (providers, plants, alerts), the draft
// queue, alert triage state, toasts and in-app navigation. Lifted out of the
// individual tabs so the sidebar badges, the dashboard, the command palette and
// the fleet screens all read the same polled data instead of fetching their own.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { hasPermission, type AuthenticatedUser, type Draft } from '@tsba/shared';
import {
  AuthError,
  getAlertTriage,
  patchAlertTriage,
  type TriagePatch,
  getSolarAlerts,
  getResolvedAlerts,
  type ResolvedAlertsResult,
  getSolarOverview,
  refreshSolarOverview,
  getSolarProviders,
  listDrafts,
  type SolarAlertsResult,
  type SolarOverview,
  type SolarProviderInfo,
  type SolarStation,
} from '../api';
import { groupAlerts, isAcked, isSnoozed, loadTriage, TRIAGE_KEY, type AlertGroup, type TriageState } from './alerts';

export type Section =
  | 'dashboard' | 'solar' | 'map' | 'energy' | 'connections' | 'knowledge'
  | 'ask' | 'drafts' | 'voice' | 'users' | 'progress' | 'settings' | 'sales' | 'profile';

export type Navigate = (section: Section, search?: string) => void;

export interface Toast {
  id: number;
  text: string;
  tone?: 'success' | 'danger' | 'info';
  action?: { label: string; run: () => void };
}

interface ConsoleValue {
  user: AuthenticatedUser;
  /** Customer PII (names, owners, addresses) visible to this role? */
  canSeePii: boolean;
  navigate: Navigate;
  onAuthError: () => void;

  providers: SolarProviderInfo[] | null;
  overview: SolarOverview | null;
  stations: SolarStation[];
  alerts: SolarAlertsResult | null;
  /** Issues resolved in the last 7 days (+ ones still confirming). */
  resolved: ResolvedAlertsResult | null;
  groups: AlertGroup[];
  /** Groups that are not acknowledged and not snoozed. */
  openGroups: AlertGroup[];
  fleetLoading: boolean;
  /** Set when the fleet couldn't be loaded (API down, network) — pages show an error, not "no plants". */
  fleetError: string | null;
  alertsLoading: boolean;
  lastUpdated: number | null;
  refreshing: boolean;
  /** Re-read the fleet. `force` bypasses the server caches and pulls fresh data from every platform (slow). */
  refreshFleet: (force?: boolean) => Promise<void>;
  providerName: (id: string) => string;
  findStation: (provider: string, id: string) => SolarStation | undefined;
  openPlant: (s: { provider: string; id: string }, opts?: { tab?: string }) => void;

  drafts: Draft[] | null;
  refreshDrafts: () => Promise<void>;
  upsertDraft: (d: Draft) => void;

  triage: Record<string, TriageState>;
  setTriage: (key: string, patch: Partial<TriageState> | null) => void;

  toast: (t: Omit<Toast, 'id'>) => void;
}

const Ctx = createContext<ConsoleValue | null>(null);

export function useConsole(): ConsoleValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useConsole must be used inside <ConsoleProvider>');
  return v;
}

const FLEET_POLL_MS = 30_000;
const DRAFT_POLL_MS = 30_000;
const EMPTY: SolarStation[] = [];

export function ConsoleProvider({
  user,
  navigate,
  onAuthError,
  children,
}: {
  user: AuthenticatedUser;
  navigate: Navigate;
  onAuthError: () => void;
  children: ReactNode;
}) {
  const [providers, setProviders] = useState<SolarProviderInfo[] | null>(null);
  const [overview, setOverview] = useState<SolarOverview | null>(null);
  const [alerts, setAlerts] = useState<SolarAlertsResult | null>(null);
  const [resolved, setResolved] = useState<ResolvedAlertsResult | null>(null);
  const [fleetLoading, setFleetLoading] = useState(true);
  const [fleetError, setFleetError] = useState<string | null>(null);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  // Shared team-wide triage (server). Starts from the legacy per-browser copy so
  // the UI isn't blank for a moment; replaced by the server map once loaded.
  const [triage, setTriageState] = useState<Record<string, TriageState>>(loadTriage);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const canPoll = useRef(false);
  const authRef = useRef(onAuthError);
  authRef.current = onAuthError;

  const handle = useCallback((err: unknown) => {
    if (err instanceof AuthError) authRef.current();
  }, []);

  // Patches not yet confirmed by the server — kept on top of each server reload
  // so a poll landing mid-save doesn't flicker an acknowledged item back.
  const pendingTriage = useRef(0);
  const migrated = useRef(false);
  const loadTriageFromServer = useCallback(async () => {
    if (pendingTriage.current > 0) return;
    try {
      const { triage: server } = await getAlertTriage();
      // One-time upload of the old per-browser triage so nothing is lost.
      if (!migrated.current) {
        migrated.current = true;
        const legacy = loadTriage();
        const now = Date.now();
        const up = Object.entries(legacy).filter(([k, t]) => !server[k] && (t.ack || (t.snoozeUntil ?? 0) > now || t.assignee));
        for (const [k, t] of up) {
          await patchAlertTriage([k], { ack: t.ack ?? null, snoozeUntil: (t.snoozeUntil ?? 0) > now ? t.snoozeUntil! : null, assignee: t.assignee ?? null })
            .then((r) => Object.assign(server, r.triage))
            .catch(() => {});
        }
        try { localStorage.removeItem(TRIAGE_KEY); } catch { /* ignore */ }
      }
      if (pendingTriage.current === 0) setTriageState(server);
    } catch (err) {
      handle(err);
    }
  }, [handle]);

  const loadAlerts = useCallback(() => {
    getSolarAlerts()
      .then(setAlerts)
      .catch(handle)
      .finally(() => setAlertsLoading(false));
    getResolvedAlerts().then(setResolved).catch(handle);
    void loadTriageFromServer();
  }, [handle, loadTriageFromServer]);

  const forcing = useRef(false);
  // Every fleet fetch takes a ticket; only the newest one may write state, so a
  // slow background poll can't land after a forced refresh and overwrite it.
  const fleetSeq = useRef(0);
  const followUps = useRef<number[]>([]);
  const booted = useRef(false);
  const unmounted = useRef(false);

  // First load: which platforms are connected, then the fleet. Retried by the
  // poll (and the Refresh buttons) until it succeeds, so a deploy/blip at page
  // load doesn't leave the console showing "no plants" until a manual reload.
  const bootFleet = useCallback(async () => {
    const id = ++fleetSeq.current;
    try {
      const { providers } = await getSolarProviders();
      if (unmounted.current || id !== fleetSeq.current) return;
      setProviders(providers);
      if (providers.some((p) => p.configured)) {
        canPoll.current = true;
        const ov = await getSolarOverview();
        if (unmounted.current || id !== fleetSeq.current) return;
        setOverview(ov);
        setLastUpdated(ov.updatedAt ?? Date.now());
        loadAlerts();
      } else {
        setAlertsLoading(false);
      }
      booted.current = true;
      setFleetError(null);
    } catch (err) {
      handle(err);
      if (!(err instanceof AuthError) && !unmounted.current) setFleetError('The monitoring data couldn’t be loaded. It will retry automatically.');
      setAlertsLoading(false);
    } finally {
      if (!unmounted.current) setFleetLoading(false);
    }
  }, [handle, loadAlerts]);

  const refreshFleet = useCallback(async (force = false) => {
    if (!booted.current) return bootFleet();
    if (!canPoll.current) return;
    // A forced pull takes 10–40s; don't let a background poll start mid-way.
    if (forcing.current && !force) return;
    if (force) forcing.current = true;
    const id = ++fleetSeq.current;
    setRefreshing(true);
    try {
      const ov = await (force ? refreshSolarOverview() : getSolarOverview());
      if (unmounted.current || id !== fleetSeq.current) return; // a newer fetch owns the state
      setOverview(ov);
      setFleetError(null);
      // The server's snapshot time, not when the browser fetched it — so
      // "updated 2 min ago" tells the truth about how fresh the numbers are.
      setLastUpdated(ov.updatedAt ?? Date.now());
      // Slow platforms (portal scrapes, GoodWe) finish after the forced pull
      // returns; the server re-sweeps when they land — fetch that promptly.
      if (force && ov.stale?.length) {
        for (const ms of [15_000, 45_000, 75_000]) followUps.current.push(window.setTimeout(() => void refreshFleet(), ms));
      }
    } catch (err) {
      handle(err);
      if (id === fleetSeq.current && !(err instanceof AuthError) && !unmounted.current) {
        setFleetError('The latest monitoring data couldn’t be loaded. Showing the last copy; it will retry automatically.');
      }
    } finally {
      if (force) forcing.current = false;
      if (id === fleetSeq.current && !unmounted.current) setRefreshing(false);
    }
    if (!unmounted.current) loadAlerts();
  }, [handle, loadAlerts, bootFleet]);

  const refreshDrafts = useCallback(async () => {
    try {
      setDrafts(await listDrafts());
    } catch (err) {
      handle(err);
      setDrafts((d) => d ?? []);
    }
  }, [handle]);

  // Initial load + polling (paused while the tab is hidden).
  useEffect(() => {
    // Sales reps only use the follow-up agent: no fleet or support data to poll.
    if (!hasPermission(user.role, 'view')) {
      setFleetLoading(false);
      setAlertsLoading(false);
      setDrafts([]);
      return;
    }
    unmounted.current = false;
    void bootFleet();
    void refreshDrafts();
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const f = window.setInterval(() => visible() && void refreshFleet(), FLEET_POLL_MS);
    const d = window.setInterval(() => visible() && void refreshDrafts(), DRAFT_POLL_MS);
    return () => {
      unmounted.current = true;
      window.clearInterval(f);
      window.clearInterval(d);
      followUps.current.forEach((t) => window.clearTimeout(t));
      followUps.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stations = overview?.stations ?? EMPTY;
  const groups = useMemo(() => groupAlerts(alerts?.alerts ?? []), [alerts]);
  const openGroups = useMemo(() => {
    const now = Date.now();
    return groups.filter((g) => !isAcked(triage[g.key], g) && !isSnoozed(triage[g.key], now));
  }, [groups, triage]);

  const providerName = useCallback(
    (id: string) => providers?.find((p) => p.id === id)?.name ?? id,
    [providers],
  );
  const stationIndex = useMemo(() => {
    const m = new Map<string, SolarStation>();
    for (const s of stations) m.set(`${s.provider}:${s.id}`, s);
    return m;
  }, [stations]);
  const findStation = useCallback((provider: string, id: string) => stationIndex.get(`${provider}:${id}`), [stationIndex]);

  const openPlant = useCallback(
    (s: { provider: string; id: string }, opts?: { tab?: string }) => {
      const qs = new URLSearchParams({ station: `${s.provider}:${s.id}` });
      if (opts?.tab) qs.set('tab', opts.tab);
      navigate('solar', `?${qs.toString()}`);
    },
    [navigate],
  );

  // Optimistic local update, then saved to the shared server store. Callers
  // often loop over many keys with the same patch (bulk acknowledge), so
  // identical patches made in the same tick are sent as ONE request.
  const batch = useRef(new Map<string, { patch: TriagePatch | null; keys: string[] }>());
  const flushTriage = useCallback(() => {
    const jobs = [...batch.current.values()];
    batch.current.clear();
    for (const { patch, keys } of jobs) {
      pendingTriage.current++;
      patchAlertTriage(keys, patch)
        .then((r) => {
          pendingTriage.current--;
          if (pendingTriage.current === 0) setTriageState(r.triage);
        })
        .catch((err) => {
          pendingTriage.current--;
          handle(err);
          void loadTriageFromServer(); // roll back to what the server has
        });
    }
  }, [handle, loadTriageFromServer]);

  const setTriage = useCallback((key: string, patch: Partial<TriageState> | null) => {
    setTriageState((prev) => {
      const next = { ...prev };
      if (patch === null) delete next[key];
      else {
        const merged: TriageState = { ...prev[key], ...patch };
        for (const k of Object.keys(merged) as (keyof TriageState)[]) if (merged[k] == null) delete merged[k];
        next[key] = merged;
      }
      return next;
    });
    // `undefined` means "clear" — send it as null so it survives JSON.
    const wire: TriagePatch | null = patch === null ? null : {};
    if (patch && wire) {
      if ('ack' in patch) wire.ack = patch.ack ?? null;
      if ('snoozeUntil' in patch) wire.snoozeUntil = patch.snoozeUntil ?? null;
      if ('assignee' in patch) wire.assignee = patch.assignee ?? null;
    }
    const sig = JSON.stringify(wire);
    const job = batch.current.get(sig) ?? { patch: wire, keys: [] };
    job.keys.push(key);
    batch.current.set(sig, job);
    queueMicrotask(flushTriage);
  }, [flushTriage]);

  const upsertDraft = useCallback((d: Draft) => {
    setDrafts((prev) => {
      const list = prev ?? [];
      return list.some((x) => x.id === d.id) ? list.map((x) => (x.id === d.id ? d : x)) : [...list, d];
    });
  }, []);

  const toastId = useRef(0);
  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastId.current;
    setToasts((list) => [...list.slice(-3), { ...t, id }]);
    window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.action ? 7000 : 4000);
  }, []);

  const value: ConsoleValue = {
    user,
    canSeePii: user.role !== 'viewer',
    navigate,
    onAuthError,
    providers,
    overview,
    stations,
    alerts,
    resolved,
    groups,
    openGroups,
    fleetLoading,
    fleetError,
    alertsLoading,
    lastUpdated,
    refreshing,
    refreshFleet,
    providerName,
    findStation,
    openPlant,
    drafts,
    refreshDrafts,
    upsertDraft,
    triage,
    setTriage,
    toast,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="c-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`c-toast ${t.tone ?? 'info'}`}>
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                className="c-toast-act"
                onClick={() => {
                  t.action!.run();
                  setToasts((list) => list.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** Convenience: does the signed-in user hold a permission? */
export function useCan() {
  const { user } = useConsole();
  return (p: Parameters<typeof hasPermission>[1]) => hasPermission(user.role, p);
}
