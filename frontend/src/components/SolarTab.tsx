import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AuthError,
  getSolarOverview,
  getSolarProviders,
  getSolarStationDetail,
  type SolarAlert,
  type SolarDevice,
  type SolarInfoItem,
  type SolarOverview,
  type SolarPowerPoint,
  type SolarProviderInfo,
  type SolarStation,
  type SolarStationDetail,
  type StationStatus,
} from '../api';

// ─── Formatting helpers ──────────────────────────────────────────────────────

/** Watts → "1.24 kW" / "820 W". */
function fmtPower(w?: number): string {
  if (w == null || Number.isNaN(w)) return '—';
  if (Math.abs(w) >= 1000) return `${(w / 1000).toFixed(2)} kW`;
  return `${Math.round(w)} W`;
}

/** kWh → "738.5 kWh" / "62.49 MWh". */
function fmtEnergy(kwh?: number): string {
  if (kwh == null || Number.isNaN(kwh)) return '—';
  if (Math.abs(kwh) >= 1000) return `${(kwh / 1000).toFixed(2)} MWh`;
  return `${kwh.toFixed(1)} kWh`;
}

function fmtCapacity(kw?: number): string {
  if (kw == null || Number.isNaN(kw)) return '—';
  return `${kw.toFixed(2)} kWp`;
}

function fmtPct(v?: number): string {
  return v == null || Number.isNaN(v) ? '—' : `${Math.round(v)}%`;
}

function fmtTime(epochSec?: number): string {
  if (!epochSec) return '—';
  const d = new Date(epochSec * 1000);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function fmtClock(epochSec?: number): string {
  if (!epochSec) return '';
  const d = new Date(epochSec * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const STATUS_META: Record<StationStatus, { cls: string; label: string }> = {
  online: { cls: 'ok', label: 'Online' },
  waiting: { cls: 'mid', label: 'Waiting' },
  partial: { cls: 'mid', label: 'Partial' },
  offline: { cls: 'flag', label: 'Offline' },
  unknown: { cls: 'muted', label: 'Unknown' },
};

// ─── Intraday power chart (inline SVG) ───────────────────────────────────────

function PowerChart({ points }: { points: SolarPowerPoint[] }) {
  const series = points.filter((p) => p.t > 0).sort((a, b) => a.t - b.t);
  if (series.length < 2) return <p className="solar-empty">No intraday power data available for this station.</p>;

  const W = 560;
  const H = 160;
  const padX = 8;
  const padY = 10;
  const max = Math.max(...series.map((s) => s.powerW), 1);
  const minT = series[0].t;
  const maxT = series[series.length - 1].t;
  const spanT = Math.max(maxT - minT, 1);
  const x = (t: number) => padX + ((t - minT) / spanT) * (W - padX * 2);
  const y = (v: number) => padY + (1 - v / max) * (H - padY * 2);
  const line = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.t).toFixed(1)},${y(s.powerW).toFixed(1)}`).join(' ');
  const area = `${line} L${x(maxT).toFixed(1)},${(H - padY).toFixed(1)} L${x(minT).toFixed(1)},${(H - padY).toFixed(1)} Z`;
  const peak = series.reduce((m, s) => (s.powerW > m.powerW ? s : m), series[0]);

  return (
    <div className="solar-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Today's generation power">
        <path d={area} className="solar-chart-area" />
        <path d={line} className="solar-chart-line" />
        <circle cx={x(peak.t)} cy={y(peak.powerW)} r={3.5} className="solar-chart-peak" />
      </svg>
      <div className="solar-chart-axis">
        <span>{fmtClock(minT)}</span>
        <span className="solar-chart-peak-label">Peak {fmtPower(peak.powerW)} · {fmtClock(peak.t)}</span>
        <span>{fmtClock(maxT)}</span>
      </div>
    </div>
  );
}

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

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`solar-metric ${accent ? 'accent' : ''}`}>
      <span className="solar-metric-value">{value}</span>
      <span className="solar-metric-label">{label}</span>
    </div>
  );
}

// ─── Station detail panel ────────────────────────────────────────────────────

function StationDetail({
  station,
  providerName,
  detail,
  loading,
  error,
  onClose,
}: {
  station: SolarStation;
  providerName: string;
  detail: SolarStationDetail | null;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  const latest = detail?.latest ?? null;
  const devices: SolarDevice[] = detail?.devices ?? [];
  const alerts: SolarAlert[] = detail?.alerts ?? [];

  return (
    <section className="card solar-detail">
      <div className="card-h">
        <div>
          <h2>{station.name}</h2>
          <span className="eyebrow">
            <span className="solar-provider-tag">{providerName}</span> · Station {station.id}
          </span>
        </div>
        <button type="button" className="ghost" onClick={onClose}>
          ← Back to stations
        </button>
      </div>

      {loading && <p className="solar-empty">Loading station data…</p>}
      {error && <span className="err">{error}</span>}

      {!loading && !error && (
        <>
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
            <h3 className="solar-h3">Today’s generation</h3>
            <PowerChart points={detail?.power ?? []} />
          </div>

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
                    </div>
                    <div className="solar-alert-meta">
                      {a.deviceSn && <span>{a.deviceSn}</span>}
                      {a.start && <span>Since {fmtTime(a.start)}</span>}
                      {a.level && <span>Level {a.level}</span>}
                    </div>
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

function SolarKpi({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className={`solar-kpi ${accent ? 'accent' : ''}`}>
      <span className="solar-kpi-value">{value}</span>
      <span className="solar-kpi-label">{label}</span>
    </div>
  );
}

// ─── Main tab ────────────────────────────────────────────────────────────────

export function SolarTab({ onAuthError }: { onAuthError: () => void }) {
  const [providers, setProviders] = useState<SolarProviderInfo[] | null>(null);
  const [overview, setOverview] = useState<SolarOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');

  const [selected, setSelected] = useState<SolarStation | null>(null);
  const [detail, setDetail] = useState<SolarStationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // True once at least one provider is connected — gates background polling.
  const canPoll = useRef(false);

  const POLL_MS = 60_000;

  /** Re-fetch the overview. Keeps the last good data on a transient failure. */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const ov = await getSolarOverview();
      setOverview(ov);
      setLastUpdated(Date.now());
      setError('');
    } catch (err) {
      if (err instanceof AuthError) onAuthError();
      // else: silent — keep showing the last snapshot until the next tick.
    } finally {
      setRefreshing(false);
    }
  }, [onAuthError]);

  // Initial load (providers + first overview), then poll every 60s while the
  // tab is visible.
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

  const openStation = (s: SolarStation) => {
    setSelected(s);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    getSolarStationDetail(s.provider, s.id)
      .then(setDetail)
      .catch((err) => {
        if (err instanceof AuthError) return onAuthError();
        setDetailError('Couldn’t load this station’s data.');
      })
      .finally(() => setDetailLoading(false));
  };

  const providerName = (id: string) => providers?.find((p) => p.id === id)?.name ?? id;
  const configured = providers?.filter((p) => p.configured) ?? [];
  const stations = overview?.stations ?? [];
  const shown = filter === 'all' ? stations : stations.filter((s) => s.provider === filter);

  const summary = useMemo(() => {
    const sum = (list: SolarStation[], f: (s: SolarStation) => number | undefined) =>
      list.reduce((acc, s) => acc + (f(s) ?? 0), 0);
    // Real-time power: exclude offline plants — they report stale/last-known
    // power, which the platform header leaves out of the live total.
    const generating = shown.filter((s) => s.status !== 'offline');
    // Installed capacity: exclude offline plants that never report power
    // (non-commissioned), matching the platform's installed-capacity figure.
    const commissioned = shown.filter((s) => !(s.status === 'offline' && s.currentPowerW == null));
    return {
      count: shown.length,
      online: shown.filter((s) => s.status === 'online').length,
      power: sum(generating, (s) => s.currentPowerW),
      daily: sum(shown, (s) => s.dailyEnergyKwh),
      monthly: sum(shown, (s) => s.monthlyEnergyKwh),
      total: sum(shown, (s) => s.totalEnergyKwh),
      capacity: sum(commissioned, (s) => s.capacityKw),
    };
  }, [shown]);

  // ── Nothing configured ──
  if (!loading && providers && configured.length === 0) {
    return (
      <div className="col">
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
      <div className="col">
        <p className="how">Loading solar monitoring…</p>
      </div>
    );
  }

  if (selected) {
    return (
      <div className="col">
        <StationDetail
          station={selected}
          providerName={providerName(selected.provider)}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          onClose={() => setSelected(null)}
        />
      </div>
    );
  }

  return (
    <div className="col">
      {error && <span className="err">{error}</span>}

      {/* Per-provider errors (e.g. one platform's credentials failing) */}
      {overview?.errors.map((e) => (
        <div key={e.provider} className="solar-provider-error">
          <strong>{e.name}</strong> couldn’t be reached: {e.error}
        </div>
      ))}

      {/* Last-updated indicator + manual refresh (auto-refreshes every 60s) */}
      <div className="solar-refresh-bar">
        <span className="solar-updated">
          {refreshing
            ? 'Updating…'
            : lastUpdated
              ? `Updated ${new Date(lastUpdated).toLocaleTimeString()} · auto every 60s`
              : ''}
        </span>
        <button type="button" className="ghost solar-refresh-btn" onClick={() => void refresh()} disabled={refreshing}>
          <span className={`solar-refresh-ico ${refreshing ? 'spin' : ''}`} aria-hidden="true">↻</span> Refresh
        </button>
      </div>

      {/* Portfolio production tiles (reflect the active filter) */}
      <div className="solar-kpi-row">
        <SolarKpi value={fmtPower(summary.power)} label="Real-time power" accent />
        <SolarKpi value={fmtCapacity(summary.capacity)} label="Installed capacity" />
        <SolarKpi value={fmtEnergy(summary.daily)} label="Daily production" />
        <SolarKpi value={fmtEnergy(summary.monthly)} label="Monthly production" />
        <SolarKpi value={fmtEnergy(summary.total)} label="Total production" />
      </div>

      {/* Provider filter (only when more than one is connected) */}
      {configured.length > 1 && (
        <div className="solar-filter">
          <button type="button" className={`solar-chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
            All ({stations.length})
          </button>
          {configured.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`solar-chip ${filter === p.id ? 'active' : ''}`}
              onClick={() => setFilter(p.id)}
            >
              {p.name} ({stations.filter((s) => s.provider === p.id).length})
            </button>
          ))}
        </div>
      )}

      <section className="card">
        <div className="card-h">
          <h2>Stations</h2>
          <span className="eyebrow">{summary.count} total · {summary.online} online</span>
        </div>

        {shown.length === 0 && (
          <p className="solar-empty">
            {filter === 'all'
              ? 'No stations found on the connected account(s).'
              : `${providerName(filter)} is connected, but this account has no plants yet.`}
          </p>
        )}

        {shown.length > 0 && (
          <div className="solar-grid">
            {shown.map((s) => {
              const meta = STATUS_META[s.status];
              return (
                <button key={`${s.provider}:${s.id}`} type="button" className="solar-card" onClick={() => openStation(s)}>
                  <div className="solar-card-head">
                    <span className="solar-card-name">{s.name}</span>
                    <span className={`solar-badge ${meta.cls}`}>{meta.label}</span>
                  </div>
                  <div className="solar-card-power">{fmtPower(s.currentPowerW)}</div>
                  <div className="solar-card-sub">
                    <span>{fmtEnergy(s.dailyEnergyKwh)} today</span>
                    <span>•</span>
                    <span>{fmtCapacity(s.capacityKw)}</span>
                  </div>
                  {s.location && <div className="solar-card-loc">{s.location}</div>}
                  <div className="solar-card-foot">
                    <span className="solar-provider-tag">{providerName(s.provider)}</span>
                    {s.batterySoc != null && <span className="solar-card-soc">SOC {fmtPct(s.batterySoc)}</span>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
