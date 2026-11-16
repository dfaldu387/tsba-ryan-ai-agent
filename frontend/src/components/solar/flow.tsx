// Live energy-flow "home" panel: the illustrated house with PV / Load / Battery /
// Grid call-outs on dotted connectors, plus a daily-energy card. Shown for every
// plant — from the provider's rich overview when it has one (SAJ), otherwise
// derived from the plant's basic live detail (see flowFromDetail).
import solarHouseImg from '../../assets/solar-house.webp';
import solarHouseLightImg from '../../assets/solar-house-light.webp';
import type { ReactNode } from 'react';
import type { EnergyFlow, SolarStation, SolarStationDetail, StationOverview } from '../../api';

/** Build a flow snapshot from the basic detail for providers without a rich overview.
 *  Returns null when there's no live power data at all. */
export function flowFromDetail(detail: SolarStationDetail | null, station: SolarStation): EnergyFlow | null {
  const l = detail?.latest;
  const pv = l?.currentPowerW ?? station.currentPowerW;
  if (pv == null && l?.consumptionPowerW == null && l?.batteryPowerW == null && l?.gridPowerW == null) return null;
  const soc = l?.batterySoc ?? station.batterySoc;
  return {
    pvPowerW: pv,
    loadPowerW: l?.consumptionPowerW,
    gridPowerW: l?.gridPowerW,
    batteryPowerW: l?.batteryPowerW,
    batterySoc: soc,
    hasPv: true,
    hasBattery: soc != null || l?.batteryPowerW != null,
    hasGrid: l?.gridPowerW != null,
    todayPvEnergyKwh: l?.dailyEnergyKwh ?? station.dailyEnergyKwh,
  };
}

/** Today's energy totals for the side card, from whichever source has them. */
function dailyTotals(flow: EnergyFlow, overview: StationOverview | null, station: SolarStation, detail: SolarStationDetail | null) {
  const stat = (k: 'pv' | 'load' | 'battery') => overview?.stats?.find((s) => s.kind === k);
  return [
    { label: 'Daily Yield', kwh: stat('pv')?.todayKwh ?? flow.todayPvEnergyKwh ?? detail?.latest?.dailyEnergyKwh ?? station.dailyEnergyKwh },
    // SAJ battery stat: energy1 = charge, energy2 = discharge.
    { label: 'Daily Charge', kwh: stat('battery')?.todayKwh ?? overview?.selfUse?.chargeEnergy },
    { label: 'Daily Discharge', kwh: stat('battery')?.today2Kwh ?? overview?.selfUse?.dischargeEnergy },
    { label: 'Daily Consumption', kwh: stat('load')?.todayKwh },
  ].filter((r, i) => i === 0 || r.kwh != null);
}

/** "45.5" → big "45" + small ".5kWh", like the vendor portal. */
function BigKwh({ kwh }: { kwh?: number }) {
  if (kwh == null || Number.isNaN(kwh)) return <span className="hf-big">—</span>;
  const s = (Math.round(kwh * 10) / 10).toString();
  const [int, dec] = s.split('.');
  return <span className="hf-big">{int}<small>{dec ? `.${dec}` : ''}kWh</small></span>;
}

/** kW value split into number + unit for the call-outs. */
function kw(w?: number): [string, string] {
  if (w == null || Number.isNaN(w)) return ['—', ''];
  const a = Math.abs(w);
  return a >= 1000 || a === 0 ? [(Math.round(a / 10) / 100).toString(), 'kW'] : [Math.round(a).toString(), 'W'];
}

type BattMode = 'charging' | 'discharging' | 'idle' | undefined;
function batteryMode(flow: EnergyFlow): BattMode {
  const d = (flow.batteryDirection || '').toLowerCase();
  if (d.includes('dis')) return 'discharging';
  if (d.includes('charg')) return 'charging';
  if (d.includes('stand') || d.includes('idle')) return 'idle';
  if (flow.batteryPowerW === 0) return 'idle';
  return undefined; // sign conventions differ by provider — don't guess
}

export function FlowPanel({
  flow, overview = null, station, detail = null,
}: {
  flow: EnergyFlow;
  overview?: StationOverview | null;
  station: SolarStation;
  detail?: SolarStationDetail | null;
}) {
  const rows = dailyTotals(flow, overview, station, detail);
  const legend = legendItems(flow, station.capacityKw);
  return (
    // .hf-wrap is a size container: the layout adapts to the width this panel
    // actually gets (e.g. Plant 360's main column), not to the viewport.
    <div className="hf-wrap">
    <div className="hf">
      <div className="hf-stage">
        <HouseFlow flow={flow} capacityKw={station.capacityKw} offline={station.status === 'offline'} />
        {/* Narrow widths: the in-picture call-outs get too small to read, so the
            same values are shown as a compact grid under the house instead. */}
        <dl className="hf-legend">
          {legend.map((l) => (
            <div key={l.name} className="hf-leg">
              <dt>{l.name}{l.extra && <b>{l.extra}</b>}</dt>
              <dd>{l.value}<small>{l.unit}</small></dd>
              {l.pill && <span className={`hf-leg-pill is-${l.mode}`}>{l.pill}</span>}
            </div>
          ))}
        </dl>
      </div>
      <aside className="hf-card">
        {rows.map((r) => (
          <div className="hf-row" key={r.label}>
            <BigKwh kwh={r.kwh} />
            <span className="hf-lbl">{r.label}</span>
          </div>
        ))}
        {(overview?.strategy || flow.runningState || flow.dataTime) && (
          <div className="hf-foot">
            {overview?.strategy && <span>Strategy <b>{overview.strategy}</b></span>}
            {flow.runningState && <span>State <b>{flow.runningState}</b></span>}
            {flow.dataTime && <span>As of {flow.dataTime}</span>}
          </div>
        )}
      </aside>
    </div>
    </div>
  );
}

const PILL: Record<NonNullable<BattMode>, string> = { charging: 'Charging', discharging: 'Discharging', idle: 'Idle' };

/** Which call-outs a flow shows, and their values — shared by the SVG and the narrow legend. */
function visibleNodes(flow: EnergyFlow) {
  return {
    batt: flow.hasBattery !== false && (flow.batteryPowerW != null || flow.batterySoc != null),
    load: flow.loadPowerW != null,
    grid: flow.hasGrid !== false && flow.gridPowerW != null,
  };
}

function legendItems(flow: EnergyFlow, capacityKw?: number) {
  const show = visibleNodes(flow);
  const mode = batteryMode(flow);
  const item = (name: string, w: number | undefined, extra?: string, withPill = false) => {
    const [value, unit] = kw(w);
    return { name, value, unit, extra, mode, pill: withPill && mode ? PILL[mode] : undefined };
  };
  return [
    item('PV', flow.pvPowerW, capacityKw ? `${capacityKw} kWp` : undefined),
    show.load && item('Load', flow.loadPowerW),
    show.batt && item('Battery', flow.batteryPowerW, flow.batterySoc != null ? `${Math.round(flow.batterySoc)}%` : undefined, true),
    show.grid && item('Grid', flow.gridPowerW, flow.gridDirection || undefined),
  ].filter(Boolean) as ReturnType<typeof item>[];
}

/** One call-out: name, big value + unit, optional extra (SOC / pill), on a dotted
 *  elbow connector to the equipment. A dot travels the connector while power flows. */
function Callout({
  x, y, name, extra, w, path, active, reverse, color = '#f59e0b', children,
}: {
  x: number; y: number; name: string; extra?: string; w?: number; path: string;
  active: boolean; reverse?: boolean; color?: string; children?: ReactNode;
}) {
  const [num, unit] = kw(w);
  return (
    <g className="hf-co">
      <path d={path} className="hf-wire" fill="none" />
      {active && (
        <circle r={5} fill={color}>
          <animateMotion dur="2.2s" repeatCount="indefinite" path={path} keyPoints={reverse ? '1;0' : '0;1'} keyTimes="0;1" calcMode="linear" />
        </circle>
      )}
      <g className="hf-txt">
        <text x={x} y={y} className="hf-name" fontSize={28}>
          {name}{extra && <tspan className="hf-val" dx={8} fontWeight={700}>{extra}</tspan>}
        </text>
        <text x={x} y={y + 50} className="hf-val" fontSize={50} fontWeight={700}>
          {num}<tspan className="hf-unit" fontSize={28} fontWeight={500} dx={6}>{unit}</tspan>
        </text>
      </g>
      {children}
    </g>
  );
}

/** House render (1376×768) with the four call-outs placed like the vendor portal:
 *  PV + Load above, Battery + Grid below. */
export function HouseFlow({ flow, capacityKw, offline }: { flow: EnergyFlow; capacityKw?: number; offline?: boolean }) {
  const live = !offline;
  const pv = flow.pvPowerW;
  const load = flow.loadPowerW;
  const batt = flow.batteryPowerW;
  const grid = flow.gridPowerW;
  const mode = batteryMode(flow);
  const { batt: showBatt, load: showLoad, grid: showGrid } = visibleNodes(flow);
  const gridExport = /export|sell|feed/i.test(flow.gridDirection || '');
  const pill = mode && PILL[mode];

  return (
    <svg viewBox="110 10 1150 750" preserveAspectRatio="xMidYMid meet" className="hf-svg" role="img"
      aria-label={`Live energy flow: PV ${kw(pv).join(' ')}${showLoad ? `, load ${kw(load).join(' ')}` : ''}${showBatt ? `, battery ${flow.batterySoc ?? '—'}%` : ''}${showGrid ? `, grid ${kw(grid).join(' ')}` : ''}`}>
      <defs>
        {/* Feather the render's top/bottom into the panel colour so its backdrop never shows a seam. */}
        <linearGradient id="hf-fade-b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="hf-fade-0" /><stop offset="1" className="hf-fade-1" /></linearGradient>
        <linearGradient id="hf-fade-t" x1="0" y1="1" x2="0" y2="0"><stop offset="0" className="hf-fade-0" /><stop offset="1" className="hf-fade-1" /></linearGradient>
      </defs>
      <image className="sh-img sh-img-dark" href={solarHouseImg} x={0} y={0} width={1376} height={768} preserveAspectRatio="xMidYMid slice" />
      <image className="sh-img sh-img-light" href={solarHouseLightImg} x={0} y={0} width={1376} height={768} preserveAspectRatio="xMidYMid slice" />
      <rect x={0} y={680} width={1376} height={88} fill="url(#hf-fade-b)" pointerEvents="none" />
      <rect x={0} y={0} width={1376} height={60} fill="url(#hf-fade-t)" pointerEvents="none" />

      {/* PV → roof panels */}
      <Callout x={540} y={55} name="PV" extra={capacityKw ? `${capacityKw} kWp` : undefined} w={pv}
        path="M560 125 V250" active={live && !!pv} />

      {/* Load → lit windows */}
      {showLoad && (
        <Callout x={1060} y={70} name="Load" w={load}
          path="M1070 140 V200 H860 V318" active={live && !!load} reverse />
      )}

      {/* Battery → battery stack */}
      {showBatt && (
        <Callout x={330} y={640} name="Battery" extra={flow.batterySoc != null ? `${Math.round(flow.batterySoc)}%` : undefined} w={batt}
          path="M520 660 H590 V610" active={live && !!batt && mode !== 'idle'} reverse={mode === 'charging'} color="#22c55e">
          {pill && (
            <g className={`hf-pill is-${mode}`}>
              <rect x={330} y={712} width={pill.length * 13.5 + 28} height={38} rx={6} />
              <text x={344} y={738} fontSize={22}>{pill}</text>
            </g>
          )}
        </Callout>
      )}

      {/* Grid → utility pole */}
      {showGrid && (
        <Callout x={150} y={470} name="Grid" extra={flow.gridDirection || undefined} w={grid}
          path="M160 540 V560 H326 V515" active={live && !!grid} reverse={!gridExport} color="#38bdf8" />
      )}
    </svg>
  );
}
