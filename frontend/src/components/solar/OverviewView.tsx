// Executive command-centre: portfolio KPIs, plant-health breakdown, top
// producers, a fleet-production trend and an AI assistant entry point.
import { useEffect, useMemo, useState } from 'react';
import { getSolarMonthlyProduction, type MonthlyProductionPoint, type SolarStation } from '../../api';
import { fmtCapacityBig, fmtEnergy, fmtPower, STATUS_META, STATUS_ORDER } from './format';
import { EmptyState, KpiTile, SectionCard, SkeletonTiles, StatusDot } from './ui';
import { TrendBars } from './charts';
import { AssistantCard } from './AssistantCard';
import type { SolarViewProps } from './types';

export function OverviewView(props: SolarViewProps) {
  const { stations, overview, alerts, providerName, openStation, goTo, lastUpdated } = props;

  const summary = useMemo(() => {
    const sum = (list: SolarStation[], f: (s: SolarStation) => number | undefined) =>
      list.reduce((acc, s) => acc + (f(s) ?? 0), 0);
    const generating = stations.filter((s) => s.status !== 'offline');
    const commissioned = stations.filter((s) => !(s.status === 'offline' && s.currentPowerW == null));
    return {
      count: stations.length,
      online: stations.filter((s) => s.status === 'online').length,
      power: sum(generating, (s) => s.currentPowerW),
      daily: sum(stations, (s) => s.dailyEnergyKwh),
      monthly: sum(stations, (s) => s.monthlyEnergyKwh),
      total: sum(stations, (s) => s.totalEnergyKwh),
      capacity: sum(commissioned, (s) => s.capacityKw),
    };
  }, [stations]);

  const health = useMemo(
    () => STATUS_ORDER.map((status) => ({ status, count: stations.filter((s) => s.status === status).length })).filter((x) => x.count > 0),
    [stations],
  );

  const topProducers = useMemo(
    () => [...stations].sort((a, b) => (b.dailyEnergyKwh ?? 0) - (a.dailyEnergyKwh ?? 0)).slice(0, 5),
    [stations],
  );

  const commIssues = (overview?.errors.length ?? 0);

  // Monthly fleet-production trend (persisted snapshots).
  const [months, setMonths] = useState<MonthlyProductionPoint[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    getSolarMonthlyProduction(6)
      .then((r) => !cancelled && setMonths(r.months))
      .catch(() => !cancelled && setMonths([]));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!overview) return <SkeletonTiles count={6} />;

  return (
    <div className="col solar-overview">
      {overview.errors.map((e) => (
        <div key={e.provider} className="solar-provider-error">
          <strong>{e.name}</strong> couldn’t be reached: {e.error}
        </div>
      ))}

      {/* Portfolio KPIs */}
      <div className="solar-tiles">
        <KpiTile icon="power" tone="accent" label="Current power generation" value={fmtPower(summary.power)} title="Live power across all online plants (offline plants excluded)." />
        <KpiTile icon="capacity" label="Installed capacity" value={fmtCapacityBig(summary.capacity)} title="Total commissioned DC capacity across the portfolio (kWp / MWp)." />
        <KpiTile icon="today" label="Today’s production" value={fmtEnergy(summary.daily)} title="Energy produced so far today." />
        <KpiTile icon="month" label="This month" value={fmtEnergy(summary.monthly)} title="Energy produced this calendar month." />
        <KpiTile icon="lifetime" label="Lifetime production" value={fmtEnergy(summary.total)} title="All-time cumulative energy." />
        <KpiTile icon="online" label="Plants online" value={`${summary.online}/${summary.count}`} title="Plants reporting as online out of the total connected." />
      </div>

      <div className="solar-ov-grid">
        {/* Plant health */}
        <SectionCard title="Plant health" eyebrow={`${summary.count} plants`} className="solar-ov-health"
          actions={<button type="button" className="ghost" onClick={() => goTo('plants')}>View all →</button>}>
          <div className="solar-health">
            {health.map(({ status, count }) => (
              <button key={status} type="button" className="solar-health-item" onClick={() => goTo('plants')}>
                <StatusDot status={status} />
                <span className="solar-health-n solar-mono">{count}</span>
                <span className="solar-health-l">{STATUS_META[status].label}</span>
              </button>
            ))}
            <button type="button" className="solar-health-item" onClick={() => goTo('integrations')}>
              <span className={`solar-dot ${commIssues ? 'flag' : 'ok'}`} />
              <span className="solar-health-n solar-mono">{commIssues}</span>
              <span className="solar-health-l">Comm. issues</span>
            </button>
          </div>
          {alerts && (
            <div className="solar-ov-alertline" onClick={() => goTo('alerts')} role="button" tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && goTo('alerts')}>
              <span className={`solar-dot ${alerts.alerts.length ? 'flag' : 'ok'}`} />
              {alerts.alerts.length === 0
                ? 'No active alerts across the fleet.'
                : `${alerts.alerts.length} active alert${alerts.alerts.length === 1 ? '' : 's'} — view details →`}
            </div>
          )}
        </SectionCard>

        {/* Top producers today */}
        <SectionCard title="Top producers today" className="solar-ov-top"
          actions={<button type="button" className="ghost" onClick={() => goTo('analytics')}>Analytics →</button>}>
          {topProducers.length === 0 || topProducers.every((s) => !s.dailyEnergyKwh) ? (
            <EmptyState title="No production data yet" hint="Plants will appear here once they report today’s energy." />
          ) : (
            <ul className="solar-toplist">
              {topProducers.map((s) => (
                <li key={`${s.provider}:${s.id}`}>
                  <button type="button" className="solar-toplist-row" onClick={() => openStation(s)}>
                    <StatusDot status={s.status} />
                    <span className="solar-toplist-name">{s.name}</span>
                    <span className="solar-toplist-prov">{providerName(s.provider)}</span>
                    <span className="solar-toplist-val solar-mono">{fmtEnergy(s.dailyEnergyKwh)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      {/* Fleet production trend */}
      <SectionCard title="Fleet production trend" eyebrow="Last 6 months">
        {months == null ? <SkeletonTiles count={1} /> : (
          <TrendBars data={months.map((m) => ({ label: m.month.slice(5), value: m.kwh }))} valueFmt={(v) => fmtEnergy(v)} />
        )}
      </SectionCard>

      <AssistantCard stations={stations} alerts={alerts} summary={summary} lastUpdated={lastUpdated} providerName={providerName} />
    </div>
  );
}
