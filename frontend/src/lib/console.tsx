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
  getSolarAlerts,
  getSolarOverview,
  getSolarProviders,
  listDrafts,
  type SolarAlertsResult,
  type SolarOverview,
  type SolarProviderInfo,
  type SolarStation,
} from '../api';
import { groupAlerts, isSnoozed, loadTriage, saveTriage, type AlertGroup, type TriageState } from './alerts';

export type Section =
  | 'dashboard' | 'solar' | 'map' | 'energy' | 'connections' | 'knowledge'
  | 'ask' | 'drafts' | 'voice' | 'users' | 'progress' | 'settings' | 'sales';

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
  groups: AlertGroup[];
  /** Groups that are not acknowledged and not snoozed. */
  openGroups: AlertGroup[];
  fleetLoading: boolean;
  alertsLoading: boolean;
  lastUpdated: number | null;
  refreshing: boolean;
  refreshFleet: () => Promise<void>;
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

const FLEET_POLL_MS = 60_000;
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
  const [fleetLoading, setFleetLoading] = useState(true);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [triage, setTriageState] = useState<Record<string, TriageState>>(loadTriage);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const canPoll = useRef(false);
  const authRef = useRef(onAuthError);
  authRef.current = onAuthError;

  const handle = useCallback((err: unknown) => {
    if (err instanceof AuthError) authRef.current();
  }, []);

  const loadAlerts = useCallback(() => {
    getSolarAlerts()
      .then(setAlerts)
      .catch(handle)
      .finally(() => setAlertsLoading(false));
  }, [handle]);

  const refreshFleet = useCallback(async () => {
    if (!canPoll.current) return;
    setRefreshing(true);
    try {
      setOverview(await getSolarOverview());
      setLastUpdated(Date.now());
    } catch (err) {
      handle(err);
    } finally {
      setRefreshing(false);
    }
    loadAlerts();
  }, [handle, loadAlerts]);

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
    let cancelled = false;
    (async () => {
      try {
        const { providers } = await getSolarProviders();
        if (cancelled) return;
        setProviders(providers);
        if (providers.some((p) => p.configured)) {
          canPoll.current = true;
          const ov = await getSolarOverview();
          if (cancelled) return;
          setOverview(ov);
          setLastUpdated(Date.now());
          loadAlerts();
        } else {
          setAlertsLoading(false);
        }
      } catch (err) {
        handle(err);
        setAlertsLoading(false);
      } finally {
        if (!cancelled) setFleetLoading(false);
      }
    })();
    void refreshDrafts();
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const f = window.setInterval(() => visible() && void refreshFleet(), FLEET_POLL_MS);
    const d = window.setInterval(() => visible() && void refreshDrafts(), DRAFT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(f);
      window.clearInterval(d);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stations = overview?.stations ?? EMPTY;
  const groups = useMemo(() => groupAlerts(alerts?.alerts ?? []), [alerts]);
  const openGroups = useMemo(() => {
    const now = Date.now();
    return groups.filter((g) => !triage[g.key]?.ack && !isSnoozed(triage[g.key], now));
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

  const setTriage = useCallback((key: string, patch: Partial<TriageState> | null) => {
    setTriageState((prev) => {
      const next = { ...prev };
      if (patch === null) delete next[key];
      else next[key] = { ...prev[key], ...patch };
      saveTriage(next);
      return next;
    });
  }, []);

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
    groups,
    openGroups,
    fleetLoading,
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
