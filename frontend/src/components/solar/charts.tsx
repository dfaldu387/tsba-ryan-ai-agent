// Inline-SVG charts for the Solar module: intraday power, the rich multi-series
// overview chart, and reusable ranked/trend bar charts for Analytics.
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ChartData, ChartSeries, SolarPowerPoint } from '../../api';
import { CHART_PALETTE, chartColor, fmtClock, fmtPower, niceStep } from './format';

// ─── Intraday power chart (inline SVG) ───────────────────────────────────────

export function PowerChart({ points }: { points: SolarPowerPoint[] }) {
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

// ─── Rich multi-series overview chart (power/SOC curve + energy comparison) ───

/** A multi-series line or bar chart (powers both the power/SOC curve and the
 *  energy-comparison bars). Lines put any %/SOC series on a right-hand axis. */
export function OverviewChart({ data, valueFmt }: { data: ChartData; valueFmt: (v: number) => string }) {
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());
  const [hoverI, setHoverI] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const W = 1000;
  const H = 300;
  const L = 52;
  const R = data.kind === 'line' && data.series.some((s) => s.secondaryAxis) ? 48 : 20;
  const T = 16;
  const B = 44;
  const iw = W - L - R;
  const ih = H - T - B;
  const x = data.xLabels;
  const n = x.length;

  const color = (s: ChartSeries, si: number) => chartColor(s.color, CHART_PALETTE[si % CHART_PALETTE.length]);
  const shown = (si: number) => !hidden.has(si);
  const toggle = (si: number) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(si)) next.delete(si);
      else next.add(si);
      // never hide the last visible series
      if (next.size >= data.series.length) return prev;
      return next;
    });

  // Axis extent from the PRIMARY (left-axis) series — stable while toggling.
  const allPrimary = data.series.filter((s) => !s.secondaryAxis).flatMap((s) => s.data).filter((v): v is number => v != null);
  let pMax = Math.max(0, ...(allPrimary.length ? allPrimary : [1]));
  let pMin = Math.min(0, ...(allPrimary.length ? allPrimary : [0]));
  if (pMax === pMin) pMax = pMin + 1;
  const span = pMax - pMin || 1;
  const step = niceStep(span / 5);
  pMax = Math.ceil(pMax / step) * step;
  pMin = Math.floor(pMin / step) * step;
  const sMax = 100; // secondary axis (SOC %)
  const secondary = data.series.filter((s) => s.secondaryAxis);

  const px = (i: number) => L + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
  const py = (v: number) => T + ih * (1 - (v - pMin) / (pMax - pMin));
  const sy = (v: number) => T + ih * (1 - v / sMax);
  const bandX = (i: number) => L + (iw * (i + 0.5)) / n;
  const hx = (i: number) => (data.kind === 'bar' ? bandX(i) : px(i));

  const ticks: number[] = [];
  for (let v = pMin; v <= pMax + 1e-6; v += step) ticks.push(Math.round(v * 100) / 100);

  const linePath = (s: ChartSeries, yf: (v: number) => number) =>
    s.data
      .map((v, i) => (v == null ? '' : `${i === 0 || s.data[i - 1] == null ? 'M' : 'L'}${px(i).toFixed(1)} ${yf(v).toFixed(1)}`))
      .join(' ')
      .trim();

  const onMove = (e: ReactPointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const vbX = ((e.clientX - r.left) / r.width) * W;
    if (vbX < L - 4 || vbX > W - R + 4) {
      setHoverI(null);
      return;
    }
    const frac = iw <= 0 ? 0 : (vbX - L) / iw;
    setHoverI(Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))));
  };

  if (!n) return null;

  // Tooltip rows (visible series only) for the hovered index.
  const hoverRows =
    hoverI == null
      ? []
      : data.series
          .map((s, si) => ({ s, si, v: s.data[hoverI] }))
          .filter((r) => shown(r.si) && r.v != null);
  const leftPct = hoverI == null ? 0 : (hx(hoverI) / W) * 100;
  const flip = leftPct > 62;

  return (
    <div className="solar-ovchart-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="solar-ovchart"
        onPointerMove={onMove}
        onPointerLeave={() => setHoverI(null)}
      >
        {/* gridlines + left axis */}
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} y1={py(v)} x2={W - R} y2={py(v)} stroke="var(--line-2, var(--line))" />
            <text x={L - 8} y={py(v) + 4} textAnchor="end" fontSize={11} fill="var(--muted)" className="solar-mono">{valueFmt(v)}</text>
          </g>
        ))}
        {/* right (%) axis for line charts with a secondary series */}
        {secondary.length > 0 && data.kind === 'line' &&
          [0, 20, 40, 60, 80, 100].map((v) => (
            <text key={`s${v}`} x={W - R + 8} y={sy(v) + 4} fontSize={11} fill="var(--muted)" className="solar-mono">{v}</text>
          ))}
        {/* x labels (thinned to ~8) */}
        {x.map((lbl, i) => {
          const every = Math.max(1, Math.ceil(n / 8));
          if (i % every !== 0 && i !== n - 1) return null;
          return <text key={i} x={hx(i)} y={H - 16} textAnchor="middle" fontSize={10} fill="var(--muted)">{lbl}</text>;
        })}
        {/* zero baseline */}
        {pMin < 0 && <line x1={L} y1={py(0)} x2={W - R} y2={py(0)} stroke="var(--muted)" opacity={0.4} />}

        {/* hover crosshair */}
        {hoverI != null && (
          <line x1={hx(hoverI)} y1={T} x2={hx(hoverI)} y2={H - B} stroke="var(--muted)" strokeWidth={1} opacity={0.5} strokeDasharray="3 3" />
        )}

        {data.kind === 'line'
          ? data.series.map((s, si) =>
              shown(si) ? (
                <path key={si} d={linePath(s, s.secondaryAxis ? sy : py)} fill="none" stroke={color(s, si)} strokeWidth={1.8} strokeLinejoin="round" />
              ) : null,
            )
          : data.series.map((s, si) => {
              if (!shown(si)) return null;
              const groups = data.series.length;
              const bw = (iw / n) * 0.8;
              const sw = bw / groups;
              return (
                <g key={si} fill={color(s, si)}>
                  {s.data.map((v, i) => {
                    if (v == null || v === 0) return null;
                    const bx = L + (iw * i) / n + (iw / n) * 0.1 + si * sw;
                    const h = Math.abs(py(v) - py(0));
                    const y = v >= 0 ? py(v) : py(0);
                    return <rect key={i} x={bx} y={y} width={Math.max(1, sw - 1)} height={Math.max(1, h)} rx={1.5} />;
                  })}
                </g>
              );
            })}

        {/* hover marker dots */}
        {hoverI != null &&
          hoverRows.map((r) => (
            <circle key={r.si} cx={hx(hoverI)} cy={(r.s.secondaryAxis ? sy : py)(r.v as number)} r={3.4} fill={color(r.s, r.si)} stroke="var(--surface)" strokeWidth={1.4} />
          ))}
      </svg>

      {/* hover tooltip */}
      {hoverI != null && hoverRows.length > 0 && (
        <div className="solar-ovchart-tip" style={{ left: `${leftPct}%`, transform: `translateX(${flip ? 'calc(-100% - 10px)' : '10px'})` }}>
          <div className="solar-ovchart-tip-t">{x[hoverI]}</div>
          {hoverRows.map((r) => (
            <div className="solar-ovchart-tip-r" key={r.si}>
              <i style={{ background: color(r.s, r.si) }} />
              <span>{r.s.name}</span>
              <b className="solar-mono">{Math.round(r.v as number).toLocaleString()}{r.s.unit ? ` ${r.s.unit}` : ''}</b>
            </div>
          ))}
        </div>
      )}

      <div className="solar-ovchart-legend">
        {data.series.map((s, si) => (
          <button type="button" key={si} className={`solar-ovchart-leg ${shown(si) ? '' : 'off'}`} onClick={() => toggle(si)}>
            <i style={{ background: color(s, si) }} />{s.name}{s.unit ? ` (${s.unit})` : ''}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Reusable ranked horizontal bars (Analytics: by plant / manufacturer) ─────

export interface RankDatum {
  label: string;
  value: number;
  sub?: string;
  color?: string;
}

/** Horizontal ranked bars with value labels. Responsive; good for comparing
 *  many categories (plants, manufacturers) by a single metric. */
export function RankBars({ data, valueFmt, max }: { data: RankDatum[]; valueFmt: (v: number) => string; max?: number }) {
  if (!data.length) return <p className="solar-empty">No data for this selection.</p>;
  const top = Math.max(max ?? 0, ...data.map((d) => d.value), 1);
  return (
    <div className="solar-rank">
      {data.map((d, i) => (
        <div className="solar-rank-row" key={`${d.label}-${i}`}>
          <span className="solar-rank-label" title={d.label}>{d.label}</span>
          <div className="solar-rank-track">
            <i
              className="solar-rank-fill"
              style={{ width: `${Math.max(1.5, (d.value / top) * 100)}%`, background: d.color || CHART_PALETTE[i % CHART_PALETTE.length] }}
            />
          </div>
          <span className="solar-rank-val solar-mono">{valueFmt(d.value)}{d.sub ? <em className="solar-rank-sub"> {d.sub}</em> : null}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Reusable vertical trend bars (Analytics: monthly fleet production) ───────

export interface TrendDatum {
  label: string;
  value: number;
}

export function TrendBars({ data, valueFmt, color = 'var(--accent)' }: { data: TrendDatum[]; valueFmt: (v: number) => string; color?: string }) {
  const [hoverI, setHoverI] = useState<number | null>(null);
  if (!data.length) return <p className="solar-empty">No historical production recorded yet.</p>;
  const W = 1000;
  const H = 260;
  const L = 56;
  const T = 16;
  const B = 36;
  const R = 12;
  const iw = W - L - R;
  const ih = H - T - B;
  const n = data.length;
  let max = Math.max(...data.map((d) => d.value), 1);
  const step = niceStep(max / 4);
  max = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-6; v += step) ticks.push(v);
  const py = (v: number) => T + ih * (1 - v / max);
  const bw = (iw / n) * 0.6;
  const bx = (i: number) => L + (iw * (i + 0.5)) / n;

  return (
    <div className="solar-ovchart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="solar-ovchart" role="img" aria-label="Monthly fleet production">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} y1={py(v)} x2={W - R} y2={py(v)} stroke="var(--line-2, var(--line))" />
            <text x={L - 8} y={py(v) + 4} textAnchor="end" fontSize={11} fill="var(--muted)" className="solar-mono">{valueFmt(v)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const h = Math.max(1, py(0) - py(d.value));
          return (
            <g key={d.label} onPointerEnter={() => setHoverI(i)} onPointerLeave={() => setHoverI(null)}>
              <rect x={bx(i) - bw / 2} y={py(d.value)} width={bw} height={h} rx={3} fill={color} opacity={hoverI == null || hoverI === i ? 1 : 0.5} />
              <text x={bx(i)} y={H - 14} textAnchor="middle" fontSize={11} fill="var(--muted)">{d.label}</text>
              {hoverI === i && (
                <text x={bx(i)} y={py(d.value) - 6} textAnchor="middle" fontSize={12} fontWeight={700} fill="var(--ink)" className="solar-mono">{valueFmt(d.value)}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
