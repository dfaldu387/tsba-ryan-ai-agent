// Fleet alerts: severity summary, filtering by severity / provider / search,
// and a detail drawer with the provider-reported diagnostics.
import { useEffect, useMemo, useState } from 'react';
import type { SolarAlertSeverity, SolarMonitorAlert, SolarStation } from '../../api';
import { fmtTime } from './format';
import { Drawer, EmptyState, ICON, KpiTile, SectionCard, SkeletonRows } from './ui';
import type { SolarViewProps } from './types';

const SEV_META: Record<SolarAlertSeverity, { label: string; cls: string }> = {
  offline: { label: 'Offline', cls: 'bad' },
  fault: { label: 'Fault', cls: 'bad' },
  partial: { label: 'Partial', cls: 'warn' },
  alert: { label: 'Alert', cls: 'warn' },
  device: { label: 'Device', cls: 'muted' },
};
const SEV_ORDER: SolarAlertSeverity[] = ['offline', 'fault', 'partial', 'alert', 'device'];

export function AlertsView({ alerts, alertsLoading, stations, providers, providerName, openStation }: SolarViewProps) {
  const [sev, setSev] = useState<'all' | SolarAlertSeverity>('all');
  const [provider, setProvider] = useState('all');
  const [search, setSearch] = useState('');
  const [active, setActive] = useState<SolarMonitorAlert | null>(null);
  const [limit, setLimit] = useState(100);

  const list = alerts?.alerts ?? [];
  const configured = providers.filter((p) => p.configured);

  const sevCounts = useMemo(
    () => SEV_ORDER.map((s) => ({ s, n: list.filter((a) => a.severity === s).length })).filter((x) => x.n > 0),
    [list],
  );

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return list.filter((a) => {
      if (sev !== 'all' && a.severity !== sev) return false;
      if (provider !== 'all' && a.provider !== provider) return false;
      if (q && !`${a.plant} ${a.title} ${a.detail ?? ''} ${a.deviceSn ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [list, sev, provider, search]);

  // Reset the render cap whenever the filters change.
  useEffect(() => setLimit(100), [sev, provider, search]);
  const visible = shown.slice(0, limit);

  const stationFor = (a: SolarMonitorAlert): SolarStation | undefined =>
    stations.find((s) => s.provider === a.provider && s.id === a.plantId);

  return (
    <div className="col">
      {alerts?.errors?.map((e) => (
        <div key={e.provider} className="solar-provider-error"><strong>{e.name}</strong> couldn’t be scanned: {e.error}</div>
      ))}

      <div className="solar-tiles">
        <KpiTile icon="alerts" tone={list.length ? 'accent' : 'default'} label="Active alerts" value={String(list.length)} />
        {SEV_ORDER.map((s) => {
          const n = list.filter((a) => a.severity === s).length;
          return n > 0 ? <KpiTile key={s} label={SEV_META[s].label} value={String(n)} /> : null;
        })}
        {alerts && <KpiTile icon="plants" label="Plants scanned" value={String(alerts.scannedPlants)} />}
      </div>

      <SectionCard
        title="Alerts"
        eyebrow={alerts ? `${shown.length} shown · scan ${new Date(alerts.generatedAt).toLocaleTimeString()}` : 'Loading…'}
      >
        <div className="solar-toolbar">
          <div className="solar-search">
            <span className="solar-search-ico">{ICON.search}</span>
            <input type="search" className="solar-search-input" placeholder="Search alerts, plants, devices…" value={search}
              onChange={(e) => setSearch(e.target.value)} aria-label="Search alerts" />
            {search && <button type="button" className="solar-search-clear" onClick={() => setSearch('')} aria-label="Clear">×</button>}
          </div>

          {sevCounts.length > 1 && (
            <div className="solar-status-chips">
              <button type="button" className={`solar-chip sm ${sev === 'all' ? 'active' : ''}`} onClick={() => setSev('all')}>All ({list.length})</button>
              {sevCounts.map(({ s, n }) => (
                <button key={s} type="button" className={`solar-chip sm ${sev === s ? 'active' : ''}`} onClick={() => setSev(s)}>
                  {SEV_META[s].label} ({n})
                </button>
              ))}
            </div>
          )}

          {configured.length > 1 && (
            <div className="solar-toolbar-right">
              <label className="solar-sort">
                <span>Provider</span>
                <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="all">All</option>
                  {configured.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            </div>
          )}
        </div>

        {alertsLoading && !alerts ? (
          <SkeletonRows rows={5} />
        ) : shown.length === 0 ? (
          <EmptyState icon="online" title={list.length === 0 ? 'No active alerts' : 'No alerts match the filters'}
            hint={list.length === 0 ? 'The whole fleet is healthy.' : 'Try clearing a filter.'} />
        ) : (
          <div className="solar-table-wrap">
            <table className="solar-table solar-alerts-table">
              <thead>
                <tr><th>Severity</th><th>Plant</th><th>Manufacturer</th><th>Alert</th><th className="num">Since</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {visible.map((a) => (
                  <tr key={a.id} className="solar-prow" onClick={() => setActive(a)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setActive(a)}>
                    <td data-label="Severity"><span className={`solar-sev ${SEV_META[a.severity].cls}`}>{SEV_META[a.severity].label}</span></td>
                    <td data-label="Plant"><span className="solar-prow-name">{a.plant}</span></td>
                    <td data-label="Manufacturer"><span className="solar-provider-tag">{providerName(a.provider)}</span></td>
                    <td data-label="Alert">{a.title}{a.deviceSn ? <span className="solar-mono solar-alert-sn"> · {a.deviceSn}</span> : null}</td>
                    <td data-label="Since" className="num">{a.at ? fmtTime(a.at) : '—'}</td>
                    <td className="solar-prow-act"><span className="solar-prow-view">Details {ICON.chevron}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length > visible.length && (
              <div className="solar-showmore">
                <span>Showing {visible.length} of {shown.length}</span>
                <button type="button" className="ghost" onClick={() => setLimit((l) => l + 200)}>Show more</button>
              </div>
            )}
          </div>
        )}
      </SectionCard>

      <Drawer
        open={active != null}
        title={active?.title ?? ''}
        eyebrow={active ? <><span className={`solar-sev ${SEV_META[active.severity].cls}`}>{SEV_META[active.severity].label}</span> · {active.plant}</> : undefined}
        onClose={() => setActive(null)}
      >
        {active && (
          <div className="solar-adrawer">
            <dl className="solar-dl">
              <div><dt>Plant</dt><dd>{active.plant}</dd></div>
              <div><dt>Manufacturer</dt><dd>{providerName(active.provider)}</dd></div>
              {active.deviceSn && <div><dt>Device</dt><dd className="solar-mono">{active.deviceSn}</dd></div>}
              <div><dt>Severity</dt><dd><span className={`solar-sev ${SEV_META[active.severity].cls}`}>{SEV_META[active.severity].label}</span></dd></div>
              <div><dt>Detected</dt><dd>{active.at ? fmtTime(active.at) : '—'}</dd></div>
            </dl>
            {active.detail && (
              <div className="solar-section">
                <h3 className="solar-h3">Diagnostic detail</h3>
                <p className="solar-adrawer-detail">{active.detail}</p>
              </div>
            )}
            {stationFor(active) && (
              <button type="button" className="ghost" onClick={() => { const s = stationFor(active); if (s) { setActive(null); openStation(s); } }}>
                Open plant detail →
              </button>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
