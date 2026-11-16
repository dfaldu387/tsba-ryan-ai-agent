// Simple, accessible SVG charts: labelled axes, a text summary for screen
// readers, keyboard/hover readout. No chart library.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
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

/** Round tick step (1, 2, 2.5, 5 × 10ⁿ) giving about `count` intervals. */
function niceStep(max: number, count = 4): number {
  if (max <= 0) return 1;
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

/** Render at the container's real pixel width so text and strokes never stretch. */
function useWidth<T extends HTMLElement>(fallback = 720) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

type Pt = { x: number; y: number };
const valid = (pts: CurvePoint[], from: number, to: number) =>
  pts.filter((p): p is Pt => p.y != null && p.x >= from && p.x <= to).sort((a, b) => a.x - b.x);

/**
 * Intraday curve. The last non-dashed series is the primary one (filled, with
 * a peak + "now" marker); others are recessive comparisons (e.g. yesterday).
 * Hours before the primary series' first reading are shown as "not recorded"
 * rather than as zero output.
 */
export function DayCurve({ series, unit, valueFmt, height = 240, xFrom = 5, xTo = 20, label, nowHour }: {
  series: CurveSeries[]; unit: string; valueFmt: (v: number) => string; height?: number; xFrom?: number; xTo?: number; label: string;
  /** Current hour of day (plant-local); draws the "now" marker. */
  nowHour?: number;
}) {
  const [wrapRef, W] = useWidth<HTMLDivElement>();
  const H = height;
  const compact = W < 520;
  const pad = { l: 44, r: compact ? 14 : 20, t: 28, b: 30 };
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gradId = useId().replace(/:/g, '');
  const hatchId = `${gradId}h`;

  // Widen the window if readings (or now) fall outside the default daylight span.
  const range = useMemo(() => {
    let lo = xFrom;
    let hi = xTo;
    for (const s of series) for (const p of s.points) if (p.y != null && p.y > 0) { lo = Math.min(lo, Math.floor(p.x)); hi = Math.max(hi, Math.ceil(p.x)); }
    if (nowHour != null) hi = Math.max(hi, Math.min(24, Math.ceil(nowHour + 0.25)));
    return { lo: Math.max(0, lo), hi: Math.min(24, hi) };
  }, [series, xFrom, xTo, nowHour]);

  const data = useMemo(() => series.map((s) => ({ ...s, pts: valid(s.points, range.lo, range.hi) })), [series, range]);
  const primaryIdx = (() => { for (let i = data.length - 1; i >= 0; i--) if (!data[i].dashed) return i; return data.length - 1; })();
  const primary = data[primaryIdx];
  const shown = data.filter((s) => s.pts.length > 0);

  const { maxY, step } = useMemo(() => {
    let m = 0;
    for (const s of data) for (const p of s.pts) m = Math.max(m, p.y);
    const st = niceStep(m * 1.1 || 1);
    return { step: st, maxY: Math.max(st, Math.ceil((m * 1.1 || 1) / st) * st) };
  }, [data]);

  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const x = (h: number) => pad.l + ((h - range.lo) / (range.hi - range.lo)) * iw;
  const y = (v: number) => pad.t + ih - (v / maxY) * ih;

  // Split into runs, breaking across gaps > 45 min (missing snapshots).
  const runs = (pts: Pt[]) => {
    const out: Pt[][] = [];
    for (const p of pts) {
      const cur = out[out.length - 1];
      if (cur && p.x - cur[cur.length - 1].x <= 0.75) cur.push(p);
      else out.push([p]);
    }
    return out;
  };
  const line = (pts: Pt[]) => runs(pts).map((r) => r.map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join('')).join('');
  const area = (pts: Pt[]) => runs(pts).filter((r) => r.length > 1)
    .map((r) => `M${x(r[0].x).toFixed(1)},${y(0)}${r.map((p) => `L${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join('')}L${x(r[r.length - 1].x).toFixed(1)},${y(0)}Z`).join('');

  const ticksY: number[] = [];
  for (let t = 0; t <= maxY + 1e-9; t += step) ticksY.push(t);
  const axisDiv = unit === 'kW' && maxY >= 1000 ? 1000 : 1;
  const axisUnit = axisDiv > 1 ? 'MW' : unit;
  const tickText = (t: number) => (t / axisDiv).toLocaleString('en-AU', { maximumFractionDigits: axisDiv > 1 ? 2 : 0 });
  const span = range.hi - range.lo;
  const every = compact ? (span > 12 ? 4 : 3) : span > 12 ? 3 : 2;
  const ticksX: number[] = [];
  for (let h = Math.ceil(range.lo); h <= range.hi; h += every) ticksX.push(h);

  const nearest = (pts: Pt[], h: number) => {
    let best: Pt | null = null;
    for (const p of pts) if (!best || Math.abs(p.x - h) < Math.abs(best.x - h)) best = p;
    return best && Math.abs(best.x - h) < 0.6 ? best : null;
  };

  const peak = primary?.pts.length ? primary.pts.reduce((a, b) => (b.y > a.y ? b : a)) : null;
  const last = primary?.pts.length ? primary.pts[primary.pts.length - 1] : null;
  // Before the first reading we simply don't know: say so instead of implying zero.
  const firstX = primary?.pts[0]?.x ?? null;
  const unrecorded = firstX != null && firstX - range.lo > 1 ? { from: range.lo, to: firstX } : null;

  const setFromClientX = (clientX: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const h = range.lo + ((clientX - r.left - pad.l) / iw) * span;
    setHover(Math.max(range.lo, Math.min(range.hi, h)));
  };
  const onKey = (e: React.KeyboardEvent) => {
    const base = hover ?? last?.x ?? range.lo;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setHover(Math.max(range.lo, Math.min(range.hi, base + (e.key === 'ArrowRight' ? 0.25 : -0.25))));
    } else if (e.key === 'Escape') setHover(null);
  };

  const summary = data.map((s) => {
    if (!s.pts.length) return `${s.name}: no data`;
    const pk = s.pts.reduce((a, b) => (b.y > a.y ? b : a));
    return `${s.name}: peak ${valueFmt(pk.y)} at ${fmtHour(pk.x)}`;
  }).join('; ');

  // Tooltip content at the hovered time.
  const tip = hover != null ? data.map((s) => ({ s, p: nearest(s.pts, hover) })).filter((r) => r.p) : [];
  const tipLeft = hover != null ? x(hover) : 0;
  const tipFlip = tipLeft > W - 190;

  // Keep the peak label clear of the "now" label when they're close.
  const showPeakLabel = peak && last && (Math.abs(x(peak.x) - x(last.x)) > 90 || Math.abs(y(peak.y) - y(last.y)) > 28);

  return (
    <figure className="c-chart" aria-label={label}>
      <div ref={wrapRef} className="c-chart-plot">
        <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" tabIndex={0}
          aria-label={`${label}. ${summary}. Use the left and right arrow keys to read values.`}
          onPointerMove={(e) => setFromClientX(e.clientX)} onPointerDown={(e) => setFromClientX(e.clientX)}
          onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className={`c-chart-fill-top t-${primary?.tone ?? 'brand'}`} />
              <stop offset="100%" className={`c-chart-fill-bot t-${primary?.tone ?? 'brand'}`} />
            </linearGradient>
            <pattern id={hatchId} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="8" className="c-chart-hatch" />
            </pattern>
          </defs>

          {ticksY.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'c-chart-base' : 'c-chart-grid'} />
              <text x={pad.l - 8} y={y(t)} className="c-chart-tick" textAnchor="end" dominantBaseline="middle">{tickText(t)}</text>
            </g>
          ))}
          <text x={pad.l - 8} y={12} className="c-chart-unit" textAnchor="end">{axisUnit}</text>
          {ticksX.map((h) => (
            <text key={h} x={x(h)} y={H - 8} className="c-chart-tick" textAnchor="middle">{fmtHour(h)}</text>
          ))}

          {unrecorded && (
            <g>
              <rect x={x(unrecorded.from)} y={pad.t} width={Math.max(0, x(unrecorded.to) - x(unrecorded.from))} height={ih} fill={`url(#${hatchId})`} className="c-chart-unrec" />
              {x(unrecorded.to) - x(unrecorded.from) > 120 && (
                <text x={(x(unrecorded.from) + x(unrecorded.to)) / 2} y={pad.t + ih / 2} className="c-chart-note" textAnchor="middle" dominantBaseline="middle">
                  Not recorded before {fmtHour(Math.ceil(unrecorded.to * 4) / 4)}
                </text>
              )}
            </g>
          )}

          {primary && primary.pts.length > 1 && <path d={area(primary.pts)} fill={`url(#${gradId})`} />}
          {data.map((s, i) => i === primaryIdx ? null : (
            <path key={s.name} d={line(s.pts)} className={`c-chart-line t-${s.tone} ${s.dashed ? 'dashed' : ''}`} />
          ))}
          {primary && <path d={line(primary.pts)} className={`c-chart-line is-primary t-${primary.tone}`} />}

          {nowHour != null && nowHour >= range.lo && nowHour <= range.hi && (
            <g>
              <line x1={x(nowHour)} x2={x(nowHour)} y1={pad.t - 4} y2={pad.t + ih} className="c-chart-now" />
              <text x={x(nowHour)} y={pad.t - 10} className="c-chart-now-t" textAnchor={x(nowHour) > W - 40 ? 'end' : 'middle'}>Now</text>
            </g>
          )}

          {peak && showPeakLabel && hover == null && (
            <g>
              <circle cx={x(peak.x)} cy={y(peak.y)} r={4} className={`c-chart-pt t-${primary!.tone}`} />
              <text x={x(peak.x)} y={y(peak.y) - 10} className="c-chart-anno" textAnchor={x(peak.x) > W - 80 ? 'end' : x(peak.x) < pad.l + 60 ? 'start' : 'middle'}>
                Peak {valueFmt(peak.y)}
              </text>
            </g>
          )}
          {last && hover == null && (
            <g>
              <circle cx={x(last.x)} cy={y(last.y)} r={5} className={`c-chart-pt is-solid t-${primary!.tone}`} />
              <text x={x(last.x) + (x(last.x) > W - 90 ? -10 : 10)} y={y(last.y) - 10} className="c-chart-anno is-strong" textAnchor={x(last.x) > W - 90 ? 'end' : 'start'}>
                {valueFmt(last.y)}
              </text>
            </g>
          )}

          {hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="c-chart-cursor" />
              {tip.map(({ s, p }) => <circle key={s.name} cx={x(p!.x)} cy={y(p!.y)} r={4.5} className={`c-chart-pt t-${s.tone}`} />)}
            </g>
          )}
        </svg>

        {hover != null && tip.length > 0 && (
          <div className={`c-chart-tip ${tipFlip ? 'is-left' : ''}`} style={{ left: tipLeft, top: pad.t }} role="status">
            <div className="c-chart-tip-h">{fmtHour(Math.round(hover * 4) / 4)}</div>
            {tip.map(({ s, p }) => (
              <div key={s.name} className={`c-chart-tip-r t-${s.tone} ${s.dashed ? 'dashed' : ''}`}>
                <i aria-hidden="true" /><span>{s.name}</span><b>{valueFmt(p!.y)}</b>
              </div>
            ))}
            {tip.length === 2 && tip[1].p!.y > 0 && tip[0].p!.y > 0 && (() => {
              const d = ((tip[1].p!.y - tip[0].p!.y) / tip[0].p!.y) * 100;
              return <div className="c-chart-tip-d">{d >= 0 ? '▲' : '▼'} {Math.abs(Math.round(d))}% vs {tip[0].s.name.toLowerCase()}</div>;
            })()}
          </div>
        )}
        {shown.length === 0 && <div className="c-chart-empty">No readings recorded yet today</div>}
      </div>

      {/* A legend only when there's something to tell apart; a series with no data says so. */}
      {data.length > 1 && (
        <figcaption className="c-chart-legend">
          {data.map((s) => (
            <span key={s.name} className={`c-chart-key t-${s.tone} ${s.dashed ? 'dashed' : ''} ${s.pts.length ? '' : 'is-empty'}`}>
              <i aria-hidden="true" />{s.name}{!s.pts.length && <em> · no data</em>}
            </span>
          ))}
          {peak && <span className="c-chart-meta">Peak {valueFmt(peak.y)} at {fmtHour(Math.round(peak.x * 4) / 4)}</span>}
        </figcaption>
      )}
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
