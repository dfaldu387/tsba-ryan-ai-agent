// Fleet shell. Data (providers, plants, alerts) and polling live in the shared
// console context; the sub-view (?view=) and open plant (?station=provider:id,
// optional &tab=) come from the URL so every screen is linkable and reload-safe.
import { useMemo } from 'react';
import { useConsole } from '../lib/console';
import { EmptyState, Icon, RelTime, SkeletonRows } from '../ui';
import type { SolarViewProps } from './solar/types';
import { OverviewPage } from '../pages/fleet/OverviewPage';
import { AnalyticsView } from './solar/AnalyticsView';
import { DevicesPage } from '../pages/fleet/DevicesPage';
import { AlertsPage } from '../pages/fleet/AlertsPage';
import { PlantsPage } from '../pages/fleet/PlantsPage';
import { Plant360 } from '../pages/fleet/Plant360';
import { IntegrationsPanel } from '../pages/IntegrationsPanel';
import '../pages/pages.css';

type View = 'overview' | 'plants' | 'analytics' | 'devices' | 'alerts' | 'integrations';
const VIEWS: View[] = ['overview', 'plants', 'analytics', 'devices', 'alerts', 'integrations'];

export function SolarTab({ search }: { search: string }) {
  const c = useConsole();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const rawView = params.get('view');
  const view: View = VIEWS.includes(rawView as View) ? (rawView as View) : 'overview';
  const stationParam = params.get('station');

  const goTo: SolarViewProps['goTo'] = (v) => c.navigate('solar', v === 'overview' ? '' : `?view=${v}`);

  if (!c.fleetLoading && c.providers && !c.providers.some((p) => p.configured)) {
    return (
      <EmptyState
        icon="link"
        title="No monitoring platform connected"
        hint="Connect Deye, GoodWe, SAJ, Solis, Sigenergy or another provider to start monitoring the fleet."
        action={<button type="button" className="c-btn primary" onClick={() => c.navigate('connections')}>Set up a connection</button>}
      />
    );
  }

  // ── Plant 360 ──
  if (stationParam) {
    const i = stationParam.indexOf(':');
    const station = i > 0 ? c.findStation(stationParam.slice(0, i), stationParam.slice(i + 1)) : undefined;
    const back = () => (window.history.length > 1 ? window.history.back() : c.navigate('solar', '?view=plants'));
    if (!station) {
      return c.fleetLoading ? <SkeletonRows rows={6} cols={4} /> : (
        <EmptyState icon="search" title="Plant not found" hint="It may have been removed from its monitoring platform."
          action={<button type="button" className="c-btn" onClick={() => c.navigate('solar', '?view=plants')}>Back to plants</button>} />
      );
    }
    return <Plant360 key={stationParam} station={station} tab={params.get('tab') ?? undefined} onBack={back} />;
  }

  const viewProps: SolarViewProps = {
    providers: c.providers ?? [],
    overview: c.overview,
    stations: c.stations,
    alerts: c.alerts,
    alertsLoading: c.alertsLoading,
    lastUpdated: c.lastUpdated,
    refreshing: c.refreshing,
    refresh: () => void c.refreshFleet(),
    providerName: c.providerName,
    openStation: (s) => c.openPlant(s),
    goTo,
  };

  return (
    <div className="pg-fleet">
      <div className="pg-fleet-bar">
        <span className="c-muted">
          {c.refreshing ? 'Updating…' : c.lastUpdated ? <>Live data · updated <RelTime t={c.lastUpdated} /> · refreshes every minute</> : null}
        </span>
        <button type="button" className="c-btn sm ghost" onClick={() => void c.refreshFleet()} disabled={c.refreshing}>
          <Icon name="refresh" size={14} /> Refresh
        </button>
      </div>
      {view === 'overview' && <OverviewPage />}
      {view === 'plants' && <PlantsPage search={search} />}
      {view === 'alerts' && <AlertsPage search={search} />}
      {view === 'devices' && <DevicesPage />}
      {view === 'analytics' && <div className="col solar-root"><AnalyticsView {...viewProps} /></div>}
      {view === 'integrations' && <IntegrationsPanel />}
    </div>
  );
}
