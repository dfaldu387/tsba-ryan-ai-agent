// Fleet overview: portfolio KPIs, plant health, top producers, the monthly
// production trend and the fleet assistant. Every tile and row links to the
// screen that explains it (Plants pre-filtered by status, Alerts, Analytics…).
import { ProviderErrors } from './ProviderErrors';
import { useEffect, useMemo, useState } from 'react';
import { getSolarMonthlyProduction, type MonthlyProductionPoint, type StationStatus } from '../../api';
import { useConsole } from '../../lib/console';
import { fmtInt, fmtKwh, fmtKwp, fmtPowerBig, installedCapacityKw, plural } from '../../lib/format';
import {
  EmptyState, ErrorState, Icon, KpiTile, ProviderChip, Section, SkeletonRows, STATION_HINT, STATION_TONE, StatusDot, type IconName,
} from '../../ui';
import { AssistantCard } from '../../components/solar/AssistantCard';

const STATUSES: StationStatus[] = ['online', 'partial', 'offline', 'waiting', 'unknown'];
const STATUS_ICON: Record<StationStatus, IconName> = { online: 'check', partial: 'alert', offline: 'offline', waiting: 'clock', unknown: 'search' };

export function OverviewPage() {
  const c = useConsole();
  const { stations, overview, alerts, providerName, openPlant, navigate, openGroups, lastUpdated, fleetLoading } = c;
  const go = (view: string, extra = '') => navigate('solar', `?view=${view}${extra}`);

  const summary = useMemo(() => {
    const sum = (f: (s: (typeof stations)[number]) => number | undefined, list = stations) => list.reduce((a, s) => a + (f(s) ?? 0), 0);
    const generating = stations.filter((s) => s.status !== 'offline');
    return {
      count: stations.length,
      online: stations.filter((s) => s.status === 'online').length,
      power: sum((s) => s.currentPowerW, generating),
      daily: sum((s) => s.dailyEnergyKwh),
      monthly: sum((s) => s.monthlyEnergyKwh),
      total: sum((s) => s.totalEnergyKwh),
      capacity: installedCapacityKw(stations),
    };
  }, [stations]);

  const counts = useMemo(() => {
    const m = {} as Record<StationStatus, number>;
    for (const st of STATUSES) m[st] = stations.filter((s) => s.status === st).length;
    return m;
  }, [stations]);

  const top = useMemo(
    () => stations.filter((s) => (s.dailyEnergyKwh ?? 0) > 0).sort((a, b) => (b.dailyEnergyKwh ?? 0) - (a.dailyEnergyKwh ?? 0)).slice(0, 6),
    [stations],
  );
  const topMax = top[0]?.dailyEnergyKwh ?? 1;

  const [months, setMonths] = useState<MonthlyProductionPoint[] | null>(null);
  useEffect(() => {
    let off = false;
    getSolarMonthlyProduction(6).then((r) => !off && setMonths(r.months)).catch(() => !off && setMonths([]));
    return () => { off = true; };
  }, []);
  const monthMax = Math.max(1, ...(months ?? []).map((m) => m.kwh));

  const critical = openGroups.filter((g) => g.severity === 'critical').length;
  const providerErrors = overview?.errors ?? [];
  const onlinePct = summary.count ? Math.round((summary.online / summary.count) * 100) : 0;

  if (fleetLoading && stations.length === 0) return <SkeletonRows rows={8} cols={4} />;
  if (c.fleetError && stations.length === 0) return <ErrorState title="Monitoring data unavailable" detail={c.fleetError} onRetry={() => void c.refreshFleet()} />;

  return (
    <div className="fo">
      <ProviderErrors errors={providerErrors} onCheck={() => navigate('connections')} />

      {/* Portfolio KPIs — each opens the screen behind the number */}
      <div className="fo-kpis">
        <KpiTile icon="bolt" tone="brand" label="Generating now" value={fmtPowerBig(summary.power)}
          sub="Across online plants" onClick={() => go('analytics')} />
        <KpiTile icon="sun" tone="gold" label="Today’s production" value={fmtKwh(summary.daily)}
          sub="Since midnight" onClick={() => go('analytics')} />
        <KpiTile icon="check" tone="success" label="Plants online" value={<>{fmtInt(summary.online)}<small>/ {fmtInt(summary.count)}</small></>}
          sub={`${onlinePct}% of the fleet`} onClick={() => go('plants', '&status=online')} />
        <KpiTile icon="alert" tone={critical ? 'danger' : 'neutral'} label="Critical alerts" value={fmtInt(critical)}
          sub={`${plural(openGroups.length, 'open issue')} in total`} onClick={() => go('alerts', critical ? '&sev=critical' : '')} />
      </div>
      <div className="fo-stats" role="list">
        <button type="button" role="listitem" className="fo-stat" onClick={() => go('plants')}>
          <span>Installed capacity</span><b>{fmtKwp(summary.capacity)}</b>
        </button>
        <button type="button" role="listitem" className="fo-stat" onClick={() => go('analytics')}>
          <span>This month</span><b>{fmtKwh(summary.monthly)}</b>
        </button>
        <button type="button" role="listitem" className="fo-stat" onClick={() => go('analytics')}>
          <span>Lifetime production</span><b>{fmtKwh(summary.total)}</b>
        </button>
        <button type="button" role="listitem" className="fo-stat" onClick={() => go('devices')}>
          <span>Devices communicating</span>
          <b>{alerts?.onlineDevices != null && alerts.totalDevices ? <>{fmtInt(alerts.onlineDevices)}<small> / {fmtInt(alerts.totalDevices)}</small></> : '—'}</b>
        </button>
      </div>

      <div className="fo-grid">
        {/* Plant health */}
        <Section title="Plant health" sub={plural(summary.count, 'plant')}
          actions={<button type="button" className="c-btn sm" onClick={() => go('plants')}>All plants <Icon name="chevron" size={14} /></button>}>
          <div className="c-pad">
            <div className="fo-healthbar" aria-hidden="true">
              {STATUSES.filter((st) => counts[st] > 0).map((st) => (
                <span key={st} className={`t-${STATION_TONE[st].tone}`} style={{ flexGrow: counts[st] }} />
              ))}
            </div>
            <div className="fo-health">
              {STATUSES.map((st) => (
                <button key={st} type="button" className={`fo-hcard t-${STATION_TONE[st].tone}`} disabled={counts[st] === 0}
                  onClick={() => go('plants', `&status=${st}`)} title={STATION_HINT[st]}>
                  <span className="fo-hcard-ico"><Icon name={STATUS_ICON[st]} size={15} /></span>
                  <b>{fmtInt(counts[st])}</b>
                  <span>{STATION_TONE[st].label}</span>
                </button>
              ))}
            </div>
            <div className="fo-links">
              <button type="button" className="fo-link" onClick={() => go('alerts')}>
                <span className={`c-sdot t-${critical ? 'danger' : openGroups.length ? 'warning' : 'success'}`}><span className="c-dot" /></span>
                {openGroups.length === 0 ? 'No open alerts' : <><b>{fmtInt(openGroups.length)}</b> open alert {openGroups.length === 1 ? 'issue' : 'issues'}{critical > 0 && <> · <b className="fo-crit">{fmtInt(critical)} critical</b></>}</>}
                <Icon name="chevron" size={14} />
              </button>
              <button type="button" className="fo-link" onClick={() => navigate('connections')}>
                <span className={`c-sdot t-${providerErrors.length ? 'danger' : 'success'}`}><span className="c-dot" /></span>
                {providerErrors.length ? <><b>{providerErrors.length}</b> provider connection {providerErrors.length === 1 ? 'issue' : 'issues'}</> : 'All provider connections healthy'}
                <Icon name="chevron" size={14} />
              </button>
            </div>
          </div>
        </Section>

        {/* Top producers today */}
        <Section title="Top producers today" sub="kWh since midnight"
          actions={<button type="button" className="c-btn sm" onClick={() => go('analytics')}>Analytics <Icon name="chevron" size={14} /></button>}>
          {top.length === 0 ? <EmptyState icon="sun" title="No production reported yet today" /> : (
            <ol className="fo-top">
              {top.map((s, i) => (
                <li key={`${s.provider}:${s.id}`}>
                  <button type="button" onClick={() => openPlant(s)}>
                    <span className="fo-rank">{i + 1}</span>
                    <span className="fo-top-main">
                      <span className="fo-top-name"><StatusDot status={s.status} /><span className="c-trunc" title={s.name}>{s.name}</span></span>
                      <span className="fo-top-bar"><span style={{ width: `${((s.dailyEnergyKwh ?? 0) / topMax) * 100}%` }} /></span>
                    </span>
                    <ProviderChip id={s.provider} name={providerName(s.provider)} />
                    <b className="fo-top-val">{fmtKwh(s.dailyEnergyKwh)}</b>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>

      {/* Monthly trend */}
      <Section title="Fleet production trend" sub="Last 6 months"
        actions={<button type="button" className="c-btn sm" onClick={() => go('analytics')}>Analytics <Icon name="chevron" size={14} /></button>}>
        {months == null ? <SkeletonRows rows={2} cols={6} /> : months.length === 0 || months.every((m) => !m.kwh) ? (
          <EmptyState icon="clock" title="Not enough history yet"
            hint="Monthly totals build up from the 15-minute snapshots the console records. The first full month appears once a month has been captured." />
        ) : (
          <div className="c-pad">
            <div className="fo-trend" role="img" aria-label={months.map((m) => `${m.month}: ${fmtKwh(m.kwh)}`).join(', ')}>
              {months.map((m) => (
                <div key={m.month} className="fo-trend-col">
                  <span className="fo-trend-v">{fmtKwh(m.kwh)}</span>
                  <span className="fo-trend-bar"><span style={{ height: `${(m.kwh / monthMax) * 100}%` }} /></span>
                  <span className="fo-trend-l">{new Date(`${m.month}-01T00:00:00`).toLocaleDateString('en-AU', { month: 'short' })}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      <AssistantCard stations={stations} alerts={alerts} summary={summary} lastUpdated={lastUpdated} providerName={providerName} />
    </div>
  );
}
