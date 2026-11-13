// Live energy-flow panel: the illustrated house with flow labels.
import solarHouseImg from '../../assets/solar-house.png';
import solarHouseLightImg from '../../assets/solar-house-light.png';
import type { StationOverview } from '../../api';
import { fmtPower, fmtPct } from './format';

/** Live energy-flow panel: the illustrated house with flow labels, plus a side
 *  column of plant facts. */
export function FlowPanel({
  flow,
  strategy,
  capacityKw,
}: {
  flow: NonNullable<StationOverview['flow']>;
  strategy?: string;
  capacityKw?: number;
}) {
  return (
    <div className="solar-flow">
      <div className="solar-flow-diagram is-dark">
        <HousePhoto flow={flow} capacityKw={capacityKw} />
      </div>
      <div className="solar-flow-side">
        {strategy && (
          <div className="solar-strat">
            <span className="solar-strat-l">Plant strategy</span>
            <span className="solar-strat-v">{strategy}</span>
          </div>
        )}
        {flow.systemPowerKw != null && (
          <div className="solar-strat">
            <span className="solar-strat-l">System power</span>
            <span className="solar-strat-v solar-mono">{flow.systemPowerKw} kW{flow.runningState ? ` · ${flow.runningState}` : ''}</span>
          </div>
        )}
        {flow.dataTime && <span className="cap solar-flow-time">As of {flow.dataTime}</span>}
      </div>
    </div>
  );
}

/** A floating value/name label with a thin connector line onto the house photo. */
function HouseLabel({
  x, y, lineTo, value, name, sub, soc, dir, dirColor, active, below,
}: {
  x: number; y: number; lineTo: number; value: string; name: string;
  sub?: string; soc?: string; dir?: string; dirColor?: string; active: boolean; below?: boolean;
}) {
  return (
    <g textAnchor="middle" className="sh-label">
      <line className="sh-line" x1={x} y1={below ? y - 92 : y + 22} x2={x} y2={lineTo} strokeWidth={2} shapeRendering="crispEdges" />
      {active && (
        <circle r={3.6} fill={dirColor || '#39c0e8'}>
          <animateMotion dur="1.5s" repeatCount="indefinite" path={below ? `M${x} ${y - 92} L${x} ${lineTo}` : `M${x} ${lineTo} L${x} ${y + 22}`} />
        </circle>
      )}
      <g className="sh-text">
        {soc && (
          <text className="sh-val" x={x} y={y - 30} fontSize={29} fontWeight={700}>
            {soc}{dir ? <tspan fontSize={20} fontWeight={700} fill={dirColor || '#39c0e8'} dx={9}>{dir}</tspan> : null}
          </text>
        )}
        <text className="sh-val" x={x} y={y} fontSize={29} fontWeight={700}>{value}</text>
        {sub && <text className="sh-val" x={x} y={y + 27} fontSize={21} fontWeight={700}>{sub}</text>}
        <text className="sh-name" x={x} y={y + (sub ? 51 : 27)} fontSize={19} fontWeight={600}>{name}</text>
      </g>
    </g>
  );
}

/** Photorealistic house render with live energy-flow labels (Grid / PV / Load /
 *  Battery), matching the portal's 2D flow view. */
export function HousePhoto({ flow, capacityKw }: { flow: NonNullable<StationOverview['flow']>; capacityKw?: number }) {
  const pv = flow.pvPowerW ?? 0;
  const load = flow.loadPowerW ?? 0;
  const batt = flow.batteryPowerW ?? 0;
  const grid = flow.gridPowerW ?? 0;
  const dischImg = /dis/i.test(flow.batteryDirection || '');
  return (
    <svg viewBox="0 0 1376 768" preserveAspectRatio="xMidYMid meet" className="solar-housephoto" role="img" aria-label="Live energy flow — house view">
      {/* House render — a light-background twin in light mode, dark in dark mode. */}
      <image className="sh-img sh-img-dark" href={solarHouseImg} x={0} y={0} width={1376} height={768} preserveAspectRatio="xMidYMid slice" />
      <image className="sh-img sh-img-light" href={solarHouseLightImg} x={0} y={0} width={1376} height={768} preserveAspectRatio="xMidYMid slice" />

      {/* Orthogonal "wiring" routing from the battery along the platform to the EV
          / load side of the house (mirrors the portal's routed connector lines). */}
      <g className="sh-line" fill="none" strokeWidth={2} strokeLinejoin="round" shapeRendering="crispEdges">
        <polyline points="590,612 590,662 905,662 905,520" />
        <polyline points="905,662 1012,662 1012,470" />
      </g>
      {(batt !== 0 || load !== 0) && (
        <circle r={3.2} fill={dischImg ? '#39c0e8' : '#34d399'}>
          <animateMotion dur="2.4s" repeatCount="indefinite" path="M590,612 L590,662 L905,662 L905,520" />
        </circle>
      )}

      {/* labels + connector lines */}
      <HouseLabel x={250} y={84} lineTo={430} value={fmtPower(grid)} name="Grid" dir={flow.gridDirection} dirColor="#39c0e8" active={grid !== 0} />
      <HouseLabel x={610} y={70} lineTo={232} value={fmtPower(pv)} name="PV" sub={capacityKw ? `${capacityKw} kWp` : undefined} active={pv !== 0} />
      <HouseLabel x={1000} y={84} lineTo={430} value={fmtPower(load)} name="Load" active={load !== 0} />
      <HouseLabel x={590} y={676} lineTo={540} value={fmtPower(batt)} name={flow.hasBattery ? 'Battery' : ''}
        soc={flow.batterySoc != null ? fmtPct(flow.batterySoc) : undefined} dir={flow.batteryDirection}
        dirColor={dischImg ? '#39c0e8' : '#34d399'} active={batt !== 0} below />
    </svg>
  );
}
