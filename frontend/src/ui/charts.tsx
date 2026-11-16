// Simple, accessible SVG charts: labelled axes, a text summary for screen
// readers, keyboard/hover readout. No chart library.
import { useMemo, useRef, useState } from 'react';
import { PLANT_TZ } from '../lib/format';

export interface CurvePoint { x: number; y: number | null } // x = hour of day (0–24)
export interface CurveSeries { name: string; points: CurvePoint[]; tone: 'brand' | 'neutral' | 'warning'; dashed?: boolean }

/** Hour-of-day (fractional) in plant-local time. */
export function hourOfDay(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: PLANT_TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h + m / 60;
}
/** yyyy-mm-dd in plant-local time (for bucketing by day). */
export function localDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PLANT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

const fmtHour = (h: number) => {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  const ap = hh >= 12 ? 'pm' : 'am';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return mm ? `${h12}:${String(mm).padStart(2, '0')} ${ap}` : `${h12} ${ap}`;
};

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const f = v / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

export function DayCurve({ series, unit, valueFmt, height = 220, xFrom = 5, xTo = 20, label }: {
  series: CurveSeries[]; unit: string; valueFmt: (v: number) => string; height?: number; xFrom?: number; xTo?: number; label: string;
}) {
  const W = 720;
  const H = height;
  const pad = { l: 52, r: 28, t: 26, b: 28 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const maxY = useMemo(() => {
    let m = 0;
    for (const s of series) for (const p of s.points) if (p.y != null && p.x >= xFrom && p.x <= xTo) m = Math.max(m, p.y);
    return niceMax(m * 1.08);
  }, [series, xFrom, xTo]);

  const x = (h: number) => pad.l + ((h - xFrom) / (xTo - xFrom)) * iw;
  const y = (v: number) => pad.t + ih - (v / maxY) * ih;

  const path = (pts: CurvePoint[]) => {
    let d = '';
    let prevX: number | null = null;
    for (const p of pts) {
      if (p.y == null || p.x < xFrom || p.x > xTo) { prevX = null; continue; }
      // break the line across gaps > 45 min (missing snapshots)
      const gap = prevX != null && p.x - prevX > 0.75;
      d += `${d && !gap ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`;
      prevX = p.x;
    }
    return d;
  };

  const ticksY = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxY);
  // One unit for the whole axis (kW → MW once the scale passes 1,000) so tick labels never mix units.
  const axisDiv = unit === 'kW' && maxY >= 1000 ? 1000 : 1;
  const axisUnit = axisDiv > 1 ? 'MW' : unit;
  const tickText = (t: number) => (t / axisDiv).toLocaleString('en-AU', { maximumFractionDigits: axisDiv > 1 ? 2 : 0 });
  const ticksX: number[] = [];
  for (let h = Math.ceil(xFrom); h <= xTo; h += (xTo - xFrom) > 12 ? 3 : 2) ticksX.push(h);

  const nearest = (s: CurveSeries, h: number) => {
    let best: CurvePoint | null = null;
    for (const p of s.points) if (p.y != null && (!best || Math.abs(p.x - h) < Math.abs(best.x - h))) best = p;
    return best && Math.abs(best.x - h) < 0.6 ? best : null;
  };

  const onMove = (e: React.PointerEvent) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    const h = xFrom + ((px - pad.l) / iw) * (xTo - xFrom);
    setHover(Math.max(xFrom, Math.min(xTo, h)));
  };

  const hasData = series.some((s) => s.points.some((p) => p.y != null));
  const summary = series
    .map((s) => {
      const vals = s.points.filter((p) => p.y != null) as { x: number; y: number }[];
      if (!vals.length) return `${s.name}: no data`;
      const peak = vals.reduce((a, b) => (b.y > a.y ? b : a));
      return `${s.name}: peak ${valueFmt(peak.y)} at ${fmtHour(peak.x)}`;
    })
    .join('; ');

  return (
    <figure className="c-chart" aria-label={label}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}. ${summary}`}
        onPointerMove={onMove} onPointerLeave={() => setHover(null)} preserveAspectRatio="none">
        {ticksY.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="c-chart-grid" />
            <text x={pad.l - 8} y={y(t)} className="c-chart-tick" textAnchor="end" dominantBaseline="middle">{tickText(t)}</text>
          </g>
        ))}
        <text x={pad.l - 8} y={12} className="c-chart-unit" textAnchor="end">{axisUnit}</text>
        {ticksX.map((h) => (
          <text key={h} x={x(h)} y={H - 8} className="c-chart-tick" textAnchor="middle">{fmtHour(h)}</text>
        ))}
        {series.map((s) => (
          <path key={s.name} d={path(s.points)} className={`c-chart-line t-${s.tone} ${s.dashed ? 'dashed' : ''}`} />
        ))}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="c-chart-cursor" />
            {series.map((s) => {
              const p = nearest(s, hover);
              return p && p.y != null ? <circle key={s.name} cx={x(p.x)} cy={y(p.y)} r={4} className={`c-chart-pt t-${s.tone}`} /> : null;
            })}
          </g>
        )}
      </svg>
      {!hasData && <div className="c-chart-empty">No readings recorded yet today</div>}
      <figcaption className="c-chart-legend">
        {series.map((s) => {
          const p = hover != null ? nearest(s, hover) : null;
          return (
            <span key={s.name} className={`c-chart-key t-${s.tone} ${s.dashed ? 'dashed' : ''}`}>
              <i aria-hidden="true" />
              {s.name}
              {p && p.y != null && <b>{valueFmt(p.y)}</b>}
            </span>
          );
        })}
        {hover != null && <span className="c-chart-at">{fmtHour(hover)}</span>}
      </figcaption>
    </figure>
  );
}

/** Small labelled bar list (value per category). */
export function BarList({ rows, valueFmt, onSelect }: {
  rows: { key: string; label: string; value: number; tone?: string; sub?: string }[];
  valueFmt: (v: number) => string;
  onSelect?: (key: string) => void;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="c-barlist">
      {rows.map((r) => {
        const inner = (
          <>
            <span className="c-barlist-l"><span className="c-trunc" title={r.label}>{r.label}</span>{r.sub && <small>{r.sub}</small>}</span>
            <span className="c-barlist-bar"><span className={r.tone ? `t-${r.tone}` : ''} style={{ width: `${(r.value / max) * 100}%` }} /></span>
            <span className="c-barlist-v">{valueFmt(r.value)}</span>
          </>
        );
        return (
          <li key={r.key}>
            {onSelect ? <button type="button" onClick={() => onSelect(r.key)}>{inner}</button> : <div>{inner}</div>}
          </li>
        );
      })}
    </ul>
  );
}
