import { useEffect, useMemo, useRef, useState } from 'react';
// globe.gl ships its own types; typed loosely here to keep the chain fluent.
import Globe from 'globe.gl';
import {
  AuthError,
  getSolarOverview,
  getSolarAlerts,
  getSolarProviders,
  getSolarMonthlyProduction,
  type SolarStation,
  type SolarMonitorAlert,
  type SolarProviderInfo,
  type MonthlyProductionPoint,
  type StationStatus,
} from '../api';
import './EnergyDashboard.css';

/* ── Tunable constants ────────────────────────────────────────────────────
   Environment-benefit conversion factors. Adjust to your reporting standard. */
const CO2_KG_PER_KWH = 0.79; // AU grid-average emissions avoided per kWh of solar
const COAL_KG_PER_KWH = 0.4; // standard-coal equivalent per kWh
const CO2_KG_PER_TREE_YEAR = 21; // CO2 a mature tree sequesters per year

const OVERVIEW_POLL_MS = 60_000; // live numbers refresh
const ALERTS_POLL_MS = 120_000; // alert scan refresh (cached ~2 min server-side)
const MONTHLY_POLL_MS = 1_800_000; // monthly trend barely moves — refresh every 30 min
const ALERTS_RENDER_CAP = 200; // max alert rows in the DOM at once (keeps the panel snappy)

/* Earth texture (dark/night look). Loaded at runtime from CDN; the globe still
   renders (atmosphere + markers) if it can't be fetched. */
const EARTH_TEXTURE = 'https://unpkg.com/three-globe/example/img/earth-night.jpg';

/* Representative coordinates per AU state/territory (capital city), used to
   place plant markers on the globe from their address text. */
const AU_STATES: Record<string, [number, number]> = {
  NSW: [-33.87, 151.21],
  'NEW SOUTH WALES': [-33.87, 151.21],
  VIC: [-37.81, 144.96],
  VICTORIA: [-37.81, 144.96],
  QLD: [-27.47, 153.02],
  QUEENSLAND: [-27.47, 153.02],
  SA: [-34.93, 138.6],
  'SOUTH AUSTRALIA': [-34.93, 138.6],
  WA: [-31.95, 115.86],
  'WESTERN AUSTRALIA': [-31.95, 115.86],
  TAS: [-42.88, 147.33],
  TASMANIA: [-42.88, 147.33],
  NT: [-12.46, 130.84],
  ACT: [-35.28, 149.13],
};
const AU_CENTROID: [number, number] = [-25.3, 133.8];

function coordsFor(location: string | undefined, seed: number): { lat: number; lng: number } {
  let base = AU_CENTROID;
  if (location) {
    const up = location.toUpperCase();
    for (const key of Object.keys(AU_STATES)) {
      // word-boundary match so "SA" doesn't hit inside other words
      if (new RegExp(`\\b${key}\\b`).test(up)) {
        base = AU_STATES[key];
        break;
      }
    }
  }
  // deterministic jitter so markers spread out but don't jump between refreshes
  const j = (n: number) => ((Math.sin(seed * 999 + n) * 10000) % 1) * 2.2 - 1.1;
  return { lat: base[0] + j(1), lng: base[1] + j(2) };
}

const STATUS_COLOR: Record<StationStatus, string> = {
  online: '#27e08a',
  waiting: '#ffb547',
  partial: '#ffb547',
  offline: '#ff5c73',
  unknown: '#4a8fc0',
};

const sum = (arr: SolarStation[], pick: (s: SolarStation) => number | undefined): number =>
  arr.reduce((acc, s) => acc + (pick(s) ?? 0), 0);

const fmt = (n: number, d = 0): string =>
  n.toLocaleString('en-AU', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Rich hover-tooltip markup for a plant. */
function tipHTML(s: SolarStation): string {
  const row = (label: string, val: string) =>
    `<div style="display:flex;justify-content:space-between;gap:14px"><span style="color:#7fa6cc">${label}</span><span>${val}</span></div>`;
  return (
    `<div style="font-weight:700;margin-bottom:5px">${s.name}</div>` +
    row('Status', s.status) +
    (s.capacityKw != null ? row('Capacity', `${fmt(s.capacityKw, 1)} kW`) : '') +
    (s.currentPowerW != null ? row('Power now', `${fmt(s.currentPowerW / 1000, 2)} kW`) : '') +
    (s.dailyEnergyKwh != null ? row('Today', `${fmt(s.dailyEnergyKwh, 1)} kWh`) : '') +
    (s.totalEnergyKwh != null ? row('Total', `${fmt(s.totalEnergyKwh / 1000, 2)} MWh`) : '') +
    (s.batterySoc != null ? row('Battery SOC', `${fmt(s.batterySoc, 0)}%`) : '') +
    (s.location ? `<div style="color:#7fa6cc;margin-top:5px">${s.location}</div>` : '')
  );
}

/* Smoothly animates a number toward `target` whenever it changes. */
function useCountUp(target: number, duration = 800): number {
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number>(0);
  useEffect(() => {
    const from = fromRef.current;
    const start = performance.now();
    cancelAnimationFrame(rafRef.current);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(from + (target - from) * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);
  return val;
}

/** A short, de-duplicated status line for an alert row (the plant name is shown
 *  separately, so we avoid repeating it here). Faults keep the provider wording. */
function shortStatus(a: SolarMonitorAlert): string {
  switch (a.severity) {
    case 'offline':
      return 'Offline — not reporting';
    case 'partial':
      return 'Partially down';
    case 'device':
      return a.deviceSn ? `Device offline (${a.deviceSn})` : 'Device offline';
    default:
      // Fault/alert: strip a trailing "— <plant>" the scan appends, to avoid echoing the name.
      return a.title.replace(/\s*—\s*[^—]*$/, '').trim() || a.title;
  }
}

interface Props {
  onExit: () => void;
  onAuthError: () => void;
}

export function EnergyDashboard({ onExit, onAuthError }: Props) {
  const [stations, setStations] = useState<SolarStation[]>([]);
  const [alerts, setAlerts] = useState<SolarMonitorAlert[]>([]);
  // Fleet device tally from the alert scan (0 for providers with no device API).
  const [deviceTotals, setDeviceTotals] = useState<{ total: number; online: number }>({ total: 0, online: 0 });
  // Monthly production trend from persisted snapshots (fills in as history builds).
  const [monthly, setMonthly] = useState<MonthlyProductionPoint[]>([]);
  const [providers, setProviders] = useState<SolarProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<number>(Date.now());
  // Real-time Alerts panel filters: by monitoring platform and by plant name.
  const [alertPlatform, setAlertPlatform] = useState<string>('all');
  const [alertPlant, setAlertPlant] = useState('');

  const globeMountRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<ReturnType<typeof Globe> | null>(null);

  // ── Data fetching + polling ──────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const onErr = (e: unknown) => {
      if (e instanceof AuthError) onAuthError();
    };
    const loadOverview = () =>
      getSolarOverview()
        .then((o) => {
          if (!alive) return;
          // Keep last-good data if a poll comes back empty (cold/just-restarted
          // backend, or a transient blip) rather than flashing the wall to 0.
          setStations((prev) => (o.stations.length === 0 && prev.length > 0 ? prev : o.stations));
          setLastUpdate(Date.now());
          setLoading(false);
          // If the fleet reads empty (cold/just-restarted backend still warming
          // its provider sessions), re-check soon instead of waiting a full cycle.
          if (o.stations.length === 0) setTimeout(() => alive && loadOverview(), 12_000);
        })
        .catch(onErr);
    const loadAlerts = () =>
      getSolarAlerts()
        .then((a) => {
          if (!alive) return;
          setAlerts(a.alerts);
          // Keep last-good counts if a scan reports 0 (cold/just-restarted backend).
          setDeviceTotals((prev) =>
            a.totalDevices && a.totalDevices > 0
              ? { total: a.totalDevices, online: a.onlineDevices ?? a.totalDevices }
              : prev,
          );
        })
        .catch(onErr);

    const loadMonthly = () =>
      getSolarMonthlyProduction(6)
        .then((r) => alive && setMonthly(r.months))
        .catch(onErr);

    getSolarProviders()
      .then((p) => alive && setProviders(p.providers))
      .catch(onErr);
    loadOverview();
    loadAlerts();
    loadMonthly();
    const o = setInterval(loadOverview, OVERVIEW_POLL_MS);
    const al = setInterval(loadAlerts, ALERTS_POLL_MS);
    const mo = setInterval(loadMonthly, MONTHLY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(o);
      clearInterval(al);
      clearInterval(mo);
    };
  }, [onAuthError]);

  const providerName = useMemo(() => {
    const m = new Map(providers.map((p) => [p.id, p.name]));
    return (id: string) => m.get(id) ?? id;
  }, [providers]);

  // ── Real-time Alerts: one row per plant (its latest/most-severe issue) ───────
  // The raw scan emits many rows per plant (plant-level + one per offline device
  // + each fault). We collapse to a single latest row per plant so the list shows
  // the plant once, keeping a count of how many issues that plant has.
  const latestPerPlant = useMemo(() => {
    const byPlant = new Map<string, { alert: SolarMonitorAlert; count: number }>();
    for (const a of alerts) {
      const k = `${a.provider}:${a.plantId}`;
      const e = byPlant.get(k);
      // `alerts` arrives pre-sorted most-severe first, so the first row seen for a
      // plant is its most-severe (latest) issue; later rows just bump the count.
      if (e) e.count++;
      else byPlant.set(k, { alert: a, count: 1 });
    }
    return [...byPlant.values()];
  }, [alerts]);

  // Platforms present in the (collapsed) alerts, with a per-platform plant count.
  const alertPlatforms = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of latestPerPlant) counts.set(e.alert.provider, (counts.get(e.alert.provider) ?? 0) + 1);
    return [...counts.entries()]
      .map(([id, count]) => ({ id, name: providerName(id), count }))
      .sort((a, b) => b.count - a.count);
  }, [latestPerPlant, providerName]);

  // Apply the platform + plant filters.
  const filteredAlerts = useMemo(() => {
    const q = alertPlant.trim().toLowerCase();
    return latestPerPlant.filter(
      (e) =>
        (alertPlatform === 'all' || e.alert.provider === alertPlatform) &&
        (!q || e.alert.plant.toLowerCase().includes(q)),
    );
  }, [latestPerPlant, alertPlatform, alertPlant]);

  // ── Derived metrics ──────────────────────────────────────────────────────
  const m = useMemo(() => {
    const systems = stations.length;
    const invCapacityKw = sum(stations, (s) => s.capacityKw);
    const realtimePowerKw = sum(stations, (s) => s.currentPowerW) / 1000;
    const totalProdKwh = sum(stations, (s) => s.totalEnergyKwh);
    const todayKwh = sum(stations, (s) => s.dailyEnergyKwh);
    const socs = stations.map((s) => s.batterySoc).filter((v): v is number => v != null);
    const avgSoc = socs.length ? socs.reduce((a, b) => a + b, 0) / socs.length : null;

    const byStatus = { online: 0, partial: 0, offline: 0, other: 0 };
    for (const s of stations) {
      if (s.status === 'online') byStatus.online++;
      else if (s.status === 'partial' || s.status === 'waiting') byStatus.partial++;
      else if (s.status === 'offline') byStatus.offline++;
      else byStatus.other++;
    }

    // per-platform aggregates (only providers that have plants)
    const perProv = new Map<string, { total: number; today: number }>();
    for (const s of stations) {
      const e = perProv.get(s.provider) ?? { total: 0, today: 0 };
      e.total += s.totalEnergyKwh ?? 0;
      e.today += s.dailyEnergyKwh ?? 0;
      perProv.set(s.provider, e);
    }
    const platforms = [...perProv.entries()]
      .map(([id, v]) => ({ id, name: providerName(id), totalMwh: v.total / 1000, todayKwh: v.today }))
      .filter((p) => p.totalMwh > 0 || p.todayKwh > 0)
      .sort((a, b) => b.totalMwh - a.totalMwh);

    const ranking = [...stations]
      .filter((s) => (s.totalEnergyKwh ?? 0) > 0)
      .sort((a, b) => (b.totalEnergyKwh ?? 0) - (a.totalEnergyKwh ?? 0))
      .slice(0, 5)
      .map((s) => ({ name: s.name, mwh: (s.totalEnergyKwh ?? 0) / 1000 }));

    const co2Tons = (totalProdKwh * CO2_KG_PER_KWH) / 1000;
    const coalTons = (totalProdKwh * COAL_KG_PER_KWH) / 1000;
    const trees = Math.round((totalProdKwh * CO2_KG_PER_KWH) / CO2_KG_PER_TREE_YEAR);

    const markers = stations.map((s, i) => {
      const c = coordsFor(s.location, i + 1);
      return { ...c, name: s.name, color: STATUS_COLOR[s.status] ?? STATUS_COLOR.unknown, s };
    });

    return {
      systems,
      invCapacityKw,
      realtimePowerKw,
      totalProdMwh: totalProdKwh / 1000,
      todayMwh: todayKwh / 1000,
      avgSoc,
      byStatus,
      platforms,
      ranking,
      co2Tons,
      coalTons,
      trees,
      markers,
    };
  }, [stations, providerName]);

  // ── Globe: init once ─────────────────────────────────────────────────────
  useEffect(() => {
    const mount = globeMountRef.current;
    if (!mount) return;
    const g = Globe()(mount)
      .backgroundColor('rgba(0,0,0,0)')
      .globeImageUrl(EARTH_TEXTURE)
      .showAtmosphere(true)
      .atmosphereColor('#27d3ff')
      .atmosphereAltitude(0.2)
      // GPU-rendered dot markers — far smoother than HTML pins when the globe
      // spins (hundreds of points cost the GPU almost nothing).
      .pointAltitude(0.01)
      .pointRadius(0.3)
      .pointColor((d: object) => (d as { color: string }).color)
      .pointLabel((d: object) => {
        const s = (d as { s: SolarStation }).s;
        return `<div style="background:rgba(8,20,38,.96);border:1px solid rgba(39,211,255,.4);border-radius:8px;padding:9px 11px;color:#eaf6ff;font:12px/1.5 system-ui;min-width:180px;max-width:240px;box-shadow:0 6px 20px rgba(0,0,0,.5)">${tipHTML(s)}</div>`;
      })
      .ringColor(() => (t: number) => `rgba(39,211,255,${Math.sqrt(1 - t)})`)
      .ringMaxRadius(2.4)
      .ringPropagationSpeed(1.6)
      .ringRepeatPeriod(1400);
    g.pointOfView({ lat: -25, lng: 134, altitude: 2 }, 0);

    const controls = g.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    // Scroll to zoom, drag to rotate; bounded so you can't fly inside the globe.
    controls.enableZoom = true;
    controls.minDistance = 115; // globe radius is 100 — lets you zoom close to a plant
    controls.maxDistance = 500;
    controls.enablePan = false;
    // Stop the idle spin as soon as the viewer grabs/zooms, so the cluster they
    // zoomed into stays put for inspection.
    controls.addEventListener('start', () => {
      controls.autoRotate = false;
    });
    // Click a plant dot to fly down to it.
    g.onPointClick((d: object) => {
      const p = d as { lat: number; lng: number };
      controls.autoRotate = false;
      g.pointOfView({ lat: p.lat, lng: p.lng, altitude: 0.22 }, 1200);
    });
    globeRef.current = g;

    const resize = () => g.width(mount.clientWidth).height(mount.clientHeight);
    resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      try {
        g.pauseAnimation?.();
        mount.innerHTML = ''; // drop the WebGL canvas, pins and tooltip
      } catch {
        /* ignore */
      }
      globeRef.current = null;
    };
  }, []);

  // ── Globe: push marker data on change ────────────────────────────────────
  useEffect(() => {
    const g = globeRef.current;
    if (!g) return;
    g.pointsData(m.markers);
    g.ringsData(m.markers);
  }, [m.markers]);

  // ── Animated numbers ─────────────────────────────────────────────────────
  const aPower = useCountUp(m.realtimePowerKw);
  const aTotal = useCountUp(m.totalProdMwh);
  const aSystems = useCountUp(m.systems);
  const aInv = useCountUp(m.invCapacityKw);
  const aToday = useCountUp(m.todayMwh);
  const aDevices = useCountUp(deviceTotals.total);

  // Escape always exits to the console, even if something overlays the ✕ button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  const dateStr = new Date().toISOString().slice(0, 10);
  const maxTotal = Math.max(1, ...m.platforms.map((p) => p.totalMwh));
  const maxToday = Math.max(1, ...m.platforms.map((p) => p.todayKwh));
  const maxRank = Math.max(1, ...m.ranking.map((r) => r.mwh));

  return (
    <div className="nrg-root">
      <header className="nrg-head">
        <h1 className="nrg-title">
          TSBA <span>Energy Platform</span>
        </h1>
        <div className="nrg-head-right">
          <span>DATE <b>{dateStr}</b></span>
          <span>Refresh <b>{OVERVIEW_POLL_MS / 1000}s</b></span>
          <span>Updated <b>{new Date(lastUpdate).toLocaleTimeString('en-AU')}</b></span>
          <button type="button" className="nrg-exit" onClick={onExit} title="Exit to console (Esc)" aria-label="Exit to console">✕</button>
        </div>
      </header>

      {loading && <div className="nrg-loading">Loading live fleet data…</div>}

      <div className="nrg-grid">
        {/* ── LEFT ── */}
        <div className="nrg-col nrg-scroll">
          <section className="nrg-panel">
            <h2 className="nrg-panel-title">Deployed Systems</h2>
            <div className="nrg-kpi-row">
              <div className="nrg-kpi">
                <div className="nrg-kpi-orb">▦</div>
                <div className="nrg-kpi-txt">
                  <div className="nrg-kpi-val">{fmt(aSystems)}</div>
                  <div className="nrg-kpi-lbl">Systems</div>
                </div>
              </div>
              <div className="nrg-kpi">
                <div className="nrg-kpi-orb">⚡</div>
                <div className="nrg-kpi-txt">
                  <div className="nrg-kpi-val">{fmt(aInv)}<span className="u">kW</span></div>
                  <div className="nrg-kpi-lbl">Inv. Capacity</div>
                </div>
              </div>
              <div className="nrg-kpi" title={deviceTotals.total > 0 ? `${deviceTotals.online} online / ${deviceTotals.total} total — inverters, batteries, loggers & meters reported by provider APIs` : undefined}>
                <div className="nrg-kpi-orb">🖧</div>
                <div className="nrg-kpi-txt">
                  <div className="nrg-kpi-val">{deviceTotals.total > 0 ? fmt(aDevices) : '—'}</div>
                  <div className="nrg-kpi-lbl">Total Devices</div>
                </div>
              </div>
            </div>
          </section>

          <section className="nrg-panel">
            <h2 className="nrg-panel-title">Production Trend <small>MWh</small></h2>
            <MonthlyTrend points={monthly} />
          </section>

          <section className="nrg-panel">
            <h2 className="nrg-panel-title">Total Production by Platform <small>MWh</small></h2>
            <div className="nrg-bars">
              {m.platforms.length === 0 && <div className="nrg-empty" style={{ width: '100%' }}>No data</div>}
              {m.platforms.map((p) => (
                <div className="nrg-bar-col" key={p.id} title={`${p.name}: ${fmt(p.totalMwh, 2)} MWh`}>
                  <div className="nrg-bar-val">{fmt(p.totalMwh, 1)}</div>
                  <div className="nrg-bar" style={{ height: `${(p.totalMwh / maxTotal) * 100}%` }} />
                  <div className="nrg-bar-lbl">{p.name}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="nrg-panel">
            <h2 className="nrg-panel-title">Today’s Generation by Platform <small>kWh</small></h2>
            <div className="nrg-bars">
              {m.platforms.length === 0 && <div className="nrg-empty" style={{ width: '100%' }}>No data</div>}
              {m.platforms.map((p) => (
                <div className="nrg-bar-col" key={p.id} title={`${p.name}: ${fmt(p.todayKwh, 1)} kWh`}>
                  <div className="nrg-bar-val">{fmt(p.todayKwh, 0)}</div>
                  <div className="nrg-bar teal" style={{ height: `${(p.todayKwh / maxToday) * 100}%` }} />
                  <div className="nrg-bar-lbl">{p.name}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="nrg-panel">
            <h2 className="nrg-panel-title">Environment Benefits</h2>
            <div className="nrg-env">
              <div className="nrg-env-item">
                <div className="nrg-env-ico">🌿</div>
                <div className="nrg-env-val">{fmt(m.co2Tons, 0)}<span className="u">tons</span></div>
                <div className="nrg-env-lbl">CO₂ Emission Saved</div>
              </div>
              <div className="nrg-env-item">
                <div className="nrg-env-ico">⛏️</div>
                <div className="nrg-env-val">{fmt(m.coalTons, 0)}<span className="u">tons</span></div>
                <div className="nrg-env-lbl">Standard Coal Saved</div>
              </div>
              <div className="nrg-env-item">
                <div className="nrg-env-ico">🌳</div>
                <div className="nrg-env-val">{fmt(m.trees, 0)}<span className="u">trees</span></div>
                <div className="nrg-env-lbl">Equivalent Trees Planted</div>
              </div>
            </div>
          </section>
        </div>

        {/* ── CENTER (globe) ── */}
        <div className="nrg-col nrg-col-center">
          <div className="nrg-chips">
            <div className="nrg-chip">
              <div className="nrg-chip-orb">⟳</div>
              <div>
                <div className="nrg-chip-lbl">Real-Time Power</div>
                <div className="nrg-chip-val">{fmt(aPower, 1)}<span className="u">kW</span></div>
              </div>
            </div>
            <div className="nrg-chip">
              <div className="nrg-chip-orb">⚡</div>
              <div>
                <div className="nrg-chip-lbl">Total Production</div>
                <div className="nrg-chip-val">{fmt(aTotal, 2)}<span className="u">MWh</span></div>
              </div>
            </div>
            <div className="nrg-chip">
              <div className="nrg-chip-orb">☀</div>
              <div>
                <div className="nrg-chip-lbl">Today</div>
                <div className="nrg-chip-val">{fmt(aToday, 2)}<span className="u">MWh</span></div>
              </div>
            </div>
          </div>
          <div className="nrg-globe" ref={globeMountRef} />
        </div>

        {/* ── RIGHT ── */}
        <div className="nrg-col nrg-scroll">
          <section className="nrg-panel">
            <h2 className="nrg-panel-title">System Status Monitoring</h2>
            <StatusDonut online={m.byStatus.online} alert={m.byStatus.partial} offline={m.byStatus.offline + m.byStatus.other} />
          </section>

          <section className="nrg-panel">
            <h2 className="nrg-panel-title">Total Production Ranking</h2>
            <div className="nrg-rank">
              {m.ranking.length === 0 && <div className="nrg-empty">No data</div>}
              {m.ranking.map((r, i) => (
                <div className="nrg-rank-row" key={i}>
                  <div className={`nrg-rank-no ${i === 1 ? 'n2' : i === 2 ? 'n3' : i > 2 ? 'nx' : ''}`}>{i + 1}</div>
                  <div className="nrg-rank-body">
                    <div className="nrg-rank-name">{r.name}</div>
                    <div className="nrg-rank-track">
                      <div className="nrg-rank-fill" style={{ width: `${(r.mwh / maxRank) * 100}%` }} />
                    </div>
                  </div>
                  <div className="nrg-rank-val">{fmt(r.mwh, 2)}<span className="u">MWh</span></div>
                </div>
              ))}
            </div>
          </section>

          <section className="nrg-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <h2 className="nrg-panel-title">
              Real-time Alerts{' '}
              <small>
                {filteredAlerts.length}
                {filteredAlerts.length !== latestPerPlant.length ? ` / ${latestPerPlant.length}` : ''} plants
              </small>
            </h2>
            {latestPerPlant.length > 0 && (
              <div className="nrg-alert-filters">
                <select
                  className="nrg-filter"
                  value={alertPlatform}
                  onChange={(e) => setAlertPlatform(e.target.value)}
                  aria-label="Filter alerts by platform"
                >
                  <option value="all">All platforms ({latestPerPlant.length})</option>
                  {alertPlatforms.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.count})
                    </option>
                  ))}
                </select>
                <input
                  className="nrg-filter"
                  type="search"
                  placeholder="Filter by plant…"
                  value={alertPlant}
                  onChange={(e) => setAlertPlant(e.target.value)}
                  aria-label="Filter alerts by plant name"
                />
              </div>
            )}
            <div className="nrg-alerts">
              {latestPerPlant.length === 0 ? (
                <div className="nrg-empty">
                  <div className="nrg-empty-orb" />
                  No active alerts
                </div>
              ) : filteredAlerts.length === 0 ? (
                <div className="nrg-empty">No alerts match this filter</div>
              ) : (
                <>
                  {filteredAlerts.slice(0, ALERTS_RENDER_CAP).map(({ alert: a, count }) => (
                    <div
                      className={`nrg-alert-row sev-${a.severity}`}
                      key={`${a.provider}:${a.plantId}`}
                      title={`${a.plant} · ${a.title}${a.detail ? ` — ${a.detail}` : ''}${count > 1 ? ` · ${count} issues on this plant` : ''}`}
                    >
                      <span className="nrg-alert-dot" />
                      <div className="nrg-alert-main">
                        <span className="nrg-alert-plant">{a.plant}</span>
                        <span className="nrg-alert-info">{shortStatus(a)}</span>
                      </div>
                      <div className="nrg-alert-meta">
                        {alertPlatform === 'all' && <span className="nrg-alert-plat">{providerName(a.provider)}</span>}
                        {count > 1 && (
                          <span className="nrg-alert-count" title={`${count} issues on this plant (devices / faults)`}>
                            {count}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  {filteredAlerts.length > ALERTS_RENDER_CAP && (
                    <div className="nrg-alert-more">
                      +{filteredAlerts.length - ALERTS_RENDER_CAP} more — narrow the filter to see them
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/* ── Monthly production trend (bars, from persisted snapshots) ────────────────
   Production per calendar month, derived server-side from the stored lifetime-
   total series — so it covers every platform, including ones whose own API has
   no history. It fills in as the snapshot recorder accumulates months. */
function MonthlyTrend({ points }: { points: MonthlyProductionPoint[] }) {
  const monthLabel = (ym: string): string => {
    const [y, m] = ym.split('-').map(Number);
    if (!y || !m) return ym;
    return new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'short' });
  };
  if (points.length === 0) {
    return (
      <div className="nrg-bars">
        <div className="nrg-empty" style={{ width: '100%' }}>
          Building history — monthly bars appear as snapshots accumulate.
        </div>
      </div>
    );
  }
  const maxMwh = Math.max(1, ...points.map((p) => p.kwh / 1000));
  return (
    <div className="nrg-bars">
      {points.map((p) => {
        const mwh = p.kwh / 1000;
        return (
          <div className="nrg-bar-col" key={p.month} title={`${p.month}: ${fmt(mwh, 2)} MWh`}>
            <div className="nrg-bar-val">{fmt(mwh, 1)}</div>
            <div className="nrg-bar teal" style={{ height: `${(mwh / maxMwh) * 100}%` }} />
            <div className="nrg-bar-lbl">{monthLabel(p.month)}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Status donut (SVG) ──────────────────────────────────────────────────── */
function StatusDonut({ online, alert, offline }: { online: number; alert: number; offline: number }) {
  const total = online + alert + offline;
  const R = 54;
  const C = 2 * Math.PI * R;
  const segs = [
    { v: online, color: '#27d3ff' },
    { v: alert, color: '#ffb547' },
    { v: offline, color: '#ff5c73' },
  ];
  let offset = 0;
  return (
    <div className="nrg-donut-wrap">
      <div className="nrg-legend">
        <span><i style={{ background: '#27d3ff' }} />Normal {online}</span>
        <span><i style={{ background: '#ff5c73' }} />Offline {offline}</span>
        <span><i style={{ background: '#ffb547' }} />Alert {alert}</span>
      </div>
      <div className="nrg-donut">
        <svg viewBox="0 0 140 140" width="140" height="140">
          <circle cx="70" cy="70" r={R} fill="none" stroke="rgba(39,211,255,0.1)" strokeWidth="14" />
          {total > 0 &&
            segs.map((s, i) => {
              if (s.v === 0) return null;
              const len = (s.v / total) * C;
              const el = (
                <circle
                  key={i}
                  cx="70"
                  cy="70"
                  r={R}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="14"
                  strokeDasharray={`${len} ${C - len}`}
                  strokeDashoffset={-offset}
                  transform="rotate(-90 70 70)"
                  strokeLinecap="butt"
                  style={{ filter: `drop-shadow(0 0 5px ${s.color})`, transition: 'stroke-dasharray 0.6s' }}
                />
              );
              offset += len;
              return el;
            })}
        </svg>
        <div className="nrg-donut-center">
          <div>
            <b>{total}</b>
            <span>Total Systems</span>
          </div>
        </div>
      </div>
    </div>
  );
}
