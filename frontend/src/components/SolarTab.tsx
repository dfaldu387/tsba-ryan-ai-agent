// Solar Monitoring shell: owns the shared fleet data (providers, overview,
// alerts) and the 60s polling, hosts the six sub-section views behind a sub-nav,
// and manages plant-detail selection (persisted in the URL so reloads/back keep
// the open plant). Each section lives in ./solar/*.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AuthError,
  getSolarAlerts,
  getSolarOverview,
  getSolarProviders,
  getSolarStationDetail,
  getStationOverview,
  type SolarAlertsResult,
  type SolarOverview,
  type SolarProviderInfo,
  type SolarStation,
  type SolarStationDetail,
  type StationOverview,
} from '../api';
import { StationDetail } from './solar/StationDetail';
import { RefreshBar, SOLAR_VIEWS, SubNav, type SolarView } from './solar/ui';
import type { SolarViewProps } from './solar/types';
import { OverviewView } from './solar/OverviewView';
import { PlantsView } from './solar/PlantsView';
import { AnalyticsView } from './solar/AnalyticsView';
import { DevicesView } from './solar/DevicesView';
import { AlertsView } from './solar/AlertsView';
import { IntegrationsView } from './solar/IntegrationsView';

const EMPTY_STATIONS: SolarStation[] = [];
const POLL_MS = 60_000;

const isView = (v: unknown): v is SolarView => SOLAR_VIEWS.includes(v as SolarView);

function initialView(): SolarView {
  try {
    const v = new URLSearchParams(window.location.search).get('view');
    if (isView(v)) return v;
  } catch { /* ignore */ }
  return 'overview';
}

export function SolarTab({ onAuthError }: { onAuthError: () => void }) {
  const [providers, setProviders] = useState<SolarProviderInfo[] | null>(null);
  const [overview, setOverview] = useState<SolarOverview | null>(null);
  const [alerts, setAlerts] = useState<SolarAlertsResult | null>(null);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<SolarView>(initialView);

  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const canPoll = useRef(false);

  // Plant detail selection.
  const [selected, setSelected] = useState<SolarStation | null>(null);
  const [detail, setDetail] = useState<SolarStationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [ovData, setOvData] = useState<StationOverview | null>(null);

  // ── Shared data refresh (overview + fleet alert scan). Keeps last good data. ──
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const ov = await getSolarOverview();
      setOverview(ov);
      setLastUpdated(Date.now());
      setError('');
    } catch (err) {
      if (err instanceof AuthError) onAuthError();
    } finally {
      setRefreshing(false);
    }
    getSolarAlerts()
      .then((a) => setAlerts(a))
      .catch((err) => { if (err instanceof AuthError) onAuthError(); })
      .finally(() => setAlertsLoading(false));
  }, [onAuthError]);

  useEffect(() => {
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
          getSolarAlerts()
            .then((a) => !cancelled && setAlerts(a))
            .catch((err) => { if (err instanceof AuthError) onAuthError(); })
            .finally(() => !cancelled && setAlertsLoading(false));
        } else {
          setAlertsLoading(false);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof AuthError) return onAuthError();
        setError('Couldn’t load solar monitoring.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const id = window.setInterval(() => {
      if (cancelled || !canPoll.current) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void refresh();
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── URL: sub-view (?view=) is reload-safe (replace, no history spam). ──
  const changeView = (v: SolarView) => {
    setView(v);
    try {
      const params = new URLSearchParams(window.location.search);
      if (v === 'overview') params.delete('view');
      else params.set('view', v);
      params.delete('station');
      const qs = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    } catch { /* ignore */ }
  };

  // ── URL: plant selection (?station=provider:id) survives reload / back. ──
  const writeStationParam = (value: string | null, push: boolean) => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (value) params.set('station', value);
      else params.delete('station');
      const qs = params.toString();
      const url = window.location.pathname + (qs ? `?${qs}` : '');
      if (push) window.history.pushState({}, '', url);
      else window.history.replaceState({}, '', url);
    } catch { /* ignore */ }
  };

  const loadStationData = (s: SolarStation) => {
    setSelected(s);
    setDetail(null);
    setOvData(null);
    setDetailError('');
    setDetailLoading(true);
    getSolarStationDetail(s.provider, s.id)
      .then(setDetail)
      .catch((err) => {
        if (err instanceof AuthError) return onAuthError();
        setDetailError('Couldn’t load this station’s data.');
      })
      .finally(() => setDetailLoading(false));
    getStationOverview(s.provider, s.id)
      .then(setOvData)
      .catch((err) => { if (err instanceof AuthError) onAuthError(); });
  };

  const openStation = (s: SolarStation) => {
    writeStationParam(`${s.provider}:${s.id}`, true);
    loadStationData(s);
  };
  const closeStation = () => {
    setSelected(null);
    writeStationParam(null, true);
  };

  const providerName = (id: string) => providers?.find((p) => p.id === id)?.name ?? id;
  const configured = providers?.filter((p) => p.configured) ?? [];
  const stations = overview?.stations ?? EMPTY_STATIONS;

  // Restore open plant from the URL once stations load; sync with back/forward.
  useEffect(() => {
    const fromUrl = (): SolarStation | null => {
      try {
        const raw = new URLSearchParams(window.location.search).get('station');
        if (!raw) return null;
        const i = raw.indexOf(':');
        if (i < 0) return null;
        return stations.find((s) => s.provider === raw.slice(0, i) && s.id === raw.slice(i + 1)) ?? null;
      } catch {
        return null;
      }
    };
    if (!selected) {
      const match = fromUrl();
      if (match) loadStationData(match);
    }
    const onPop = () => {
      const match = fromUrl();
      if (match) loadStationData(match);
      else setSelected(null);
      const v = new URLSearchParams(window.location.search).get('view');
      setView(isView(v) ? v : 'overview');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations]);

  // ── Nothing configured ──
  if (!loading && providers && configured.length === 0) {
    return (
      <div className="col solar-root">
        <section className="card solar-setup">
          <div className="card-h">
            <h2>Connect a monitoring platform</h2>
            <span className="eyebrow">Nothing connected</span>
          </div>
          <p className="how">
            Add a provider’s credentials to the server’s <code>.env</code> file and restart the backend. Each platform
            is read live — nothing is stored.
          </p>
          <ul className="solar-provider-status">
            {providers.map((p) => (
              <li key={p.id}>
                <span className={`solar-dot ${p.configured ? 'ok' : 'flag'}`} />
                <strong>{p.name}</strong>
                <span className="solar-badge muted">{p.configured ? 'Connected' : 'Not configured'}</span>
              </li>
            ))}
          </ul>
          <pre className="solar-env">{`# Deye Cloud
DEYE_APP_ID=...        DEYE_APP_SECRET=...
DEYE_EMAIL=...         DEYE_PASSWORD=...
DEYE_BASE_URL=https://eu1-developer.deyecloud.com

# GoodWe (SEMS) — no app key needed
GOODWE_EMAIL=...       GOODWE_PASSWORD=...
GOODWE_REGION=au       # au | eu | us | global`}</pre>
        </section>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="col solar-root">
        <p className="how">Loading solar monitoring…</p>
      </div>
    );
  }

  // Plant detail takes over the whole Solar area.
  if (selected) {
    return (
      <div className="col solar-root">
        <StationDetail
          station={selected}
          providerName={providerName(selected.provider)}
          detail={detail}
          overview={ovData}
          loading={detailLoading}
          error={detailError}
          onClose={closeStation}
        />
      </div>
    );
  }

  const viewProps: SolarViewProps = {
    providers: providers ?? [],
    overview,
    stations,
    alerts,
    alertsLoading,
    lastUpdated,
    refreshing,
    refresh,
    providerName,
    openStation,
    goTo: changeView,
  };

  return (
    <div className="col solar-shell solar-root">
      {error && <span className="err">{error}</span>}

      <div className="solar-shell-head">
        <SubNav active={view} onChange={changeView} alertCount={alerts?.alerts.length} />
        <RefreshBar lastUpdated={lastUpdated} refreshing={refreshing} onRefresh={() => void refresh()} />
      </div>

      {view === 'overview' && <OverviewView {...viewProps} />}
      {view === 'plants' && <PlantsView {...viewProps} />}
      {view === 'analytics' && <AnalyticsView {...viewProps} />}
      {view === 'devices' && <DevicesView {...viewProps} />}
      {view === 'alerts' && <AlertsView {...viewProps} />}
      {view === 'integrations' && <IntegrationsView {...viewProps} />}
    </div>
  );
}
