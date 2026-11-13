// Full plant detail: rich overview (flow/KPIs/charts) when available, otherwise
// basic metrics, plus plant facts, device inventory and active alerts.
import type {
  SolarAlert,
  SolarDevice,
  SolarInfoItem,
  SolarStation,
  SolarStationDetail,
  StationOverview,
} from '../../api';
import { fmtCapacity, fmtEnergy, fmtPct, fmtPower, fmtTime, STATUS_META } from './format';
import { Metric, OverviewSections } from './kpis';
import { PowerChart } from './charts';

/** Base plant details from the station record, used when a provider returns no `info`. */
function fallbackInfo(s: SolarStation): SolarInfoItem[] {
  const items: [string, string | undefined][] = [
    ['Status', STATUS_META[s.status].label],
    ['Location', s.location],
    ['Installed capacity', s.capacityKw != null ? fmtCapacity(s.capacityKw) : undefined],
    ['Battery SOC', s.batterySoc != null ? fmtPct(s.batterySoc) : undefined],
    ['Today', s.dailyEnergyKwh != null ? fmtEnergy(s.dailyEnergyKwh) : undefined],
    ['This month', s.monthlyEnergyKwh != null ? fmtEnergy(s.monthlyEnergyKwh) : undefined],
    ['Total', s.totalEnergyKwh != null ? fmtEnergy(s.totalEnergyKwh) : undefined],
    ['Last update', s.lastUpdate ? fmtTime(s.lastUpdate) : undefined],
    ['Station ID', s.id],
  ];
  return items.filter(([, v]) => v).map(([label, value]) => ({ label, value: value as string }));
}

export function StationDetail({
  station,
  providerName,
  detail,
  overview,
  loading,
  error,
  onClose,
}: {
  station: SolarStation;
  providerName: string;
  detail: SolarStationDetail | null;
  overview: StationOverview | null;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  const latest = detail?.latest ?? null;
  const devices: SolarDevice[] = detail?.devices ?? [];
  const alerts: SolarAlert[] = detail?.alerts ?? [];
  const hasOverview = Boolean(overview && (overview.flow || overview.stats?.length || overview.powerCurve || overview.comparison));

  return (
    <section className="card solar-detail">
      <div className="card-h">
        <div>
          <h2>{station.name}</h2>
          <span className="eyebrow">
            <span className="solar-provider-tag">{providerName}</span> · Station {station.id}
            {station.location ? ` · ${station.location}` : ''}
          </span>
        </div>
        <button type="button" className="ghost" onClick={onClose}>
          ← Back
        </button>
      </div>

      {/* Rich Overview (flow, KPI cards, curve analysis, charts, environmental).
          Loads independently of the basic detail, so it can appear before the
          device/alert data finishes. */}
      {hasOverview && overview && <OverviewSections overview={overview} station={station} />}

      {loading && <p className="solar-empty">Loading station data…</p>}
      {error && <span className="err">{error}</span>}

      {!loading && !error && (
        <>
          {!hasOverview && (
            <div className="solar-metric-grid">
              <Metric label="Current power" value={fmtPower(latest?.currentPowerW ?? station.currentPowerW)} accent />
              <Metric label="Today" value={fmtEnergy(latest?.dailyEnergyKwh ?? station.dailyEnergyKwh)} />
              <Metric label="This month" value={fmtEnergy(latest?.monthlyEnergyKwh ?? station.monthlyEnergyKwh)} />
              <Metric label="Total" value={fmtEnergy(latest?.totalEnergyKwh ?? station.totalEnergyKwh)} />
              <Metric label="Capacity" value={fmtCapacity(station.capacityKw)} />
              {(latest?.batterySoc ?? station.batterySoc) != null && (
                <Metric label="Battery SOC" value={fmtPct(latest?.batterySoc ?? station.batterySoc)} />
              )}
              {latest?.consumptionPowerW != null && <Metric label="Consumption" value={fmtPower(latest.consumptionPowerW)} />}
              {latest?.gridPowerW != null && <Metric label="Grid" value={fmtPower(latest.gridPowerW)} />}
              {latest?.batteryPowerW != null && <Metric label="Battery" value={fmtPower(latest.batteryPowerW)} />}
            </div>
          )}

          {/* Today's generation curve — only when the rich power/SOC chart isn't shown. */}
          {!hasOverview && (
            <div className="solar-section">
              <h3 className="solar-h3">Today’s generation</h3>
              <PowerChart points={detail?.power ?? []} />
            </div>
          )}

          {(() => {
            const info = detail?.info?.length ? detail.info : fallbackInfo(station);
            return info.length > 0 ? (
              <div className="solar-section">
                <h3 className="solar-h3">Plant details</h3>
                <div className="solar-info-grid">
                  {info.map((it) => (
                    <div className="solar-info-item" key={it.label}>
                      <span className="solar-info-label">{it.label}</span>
                      <span className="solar-info-value">{it.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null;
          })()}

          <div className="solar-section">
            <h3 className="solar-h3">Devices ({devices.length})</h3>
            {devices.length === 0 ? (
              <p className="solar-empty">No device data exposed by this provider.</p>
            ) : (
              <div className="solar-table-wrap">
                <table className="solar-table">
                  <thead>
                    <tr>
                      <th>Serial</th>
                      <th>Type</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((d, i) => (
                      <tr key={d.sn || i}>
                        <td className="solar-mono">{d.sn || '—'}</td>
                        <td>{d.type || '—'}</td>
                        <td>
                          <span className={`solar-dot ${d.online ? 'ok' : 'flag'}`} />
                          {d.online ? 'Online' : 'Offline'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="solar-section">
            <h3 className="solar-h3">
              Active alerts
              {alerts.length > 0 && <span className="solar-badge flag">{alerts.length}</span>}
            </h3>
            {alerts.length === 0 ? (
              <p className="solar-empty">No active alerts.</p>
            ) : (
              <ul className="solar-alert-list">
                {alerts.map((a, i) => (
                  <li key={a.id || i} className="solar-alert">
                    <div className="solar-alert-head">
                      <strong>{a.name}</strong>
                      {a.code && <code className="solar-mono">{a.code}</code>}
                      {a.status && (
                        <span className={`solar-alert-status ${a.status.toLowerCase().replace(/\s+/g, '-')}`}>
                          {a.status}
                        </span>
                      )}
                    </div>
                    <div className="solar-alert-meta">
                      {a.deviceSn && <span>{a.deviceSn}</span>}
                      {a.start && <span>Since {fmtTime(a.start)}</span>}
                      {a.level && <span>Level {a.level}</span>}
                    </div>
                    {a.reason && a.reason !== a.name && (
                      <div className="solar-alert-reason">
                        <span className="solar-alert-label">Reason</span>
                        {a.reason}
                      </div>
                    )}
                    {a.solution && (
                      <div className="solar-alert-solution">
                        <span className="solar-alert-label">Solution</span>
                        <div className="solar-alert-solution-body">{a.solution}</div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
