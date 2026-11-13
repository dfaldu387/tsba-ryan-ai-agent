// Rich plant-overview building blocks: flow + KPI cards + curve-analysis bars +
// environmental tiles, assembled by OverviewSections.
import type { ReactNode } from 'react';
import type { EnergyStat, SolarStation, StationOverview } from '../../api';
import { fmtDelta, fmtEnergy } from './format';
import { FlowPanel } from './flow';
import { OverviewChart } from './charts';

export function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`solar-metric ${accent ? 'accent' : ''}`}>
      <span className="solar-metric-value">{value}</span>
      <span className="solar-metric-label">{label}</span>
    </div>
  );
}

export function OverviewSections({ overview, station }: { overview: StationOverview; station: SolarStation }) {
  const { flow, stats, selfUse, powerCurve, comparison, environmental, strategy } = overview;
  return (
    <>
      {flow && <FlowPanel flow={flow} strategy={strategy} capacityKw={station.capacityKw} />}
      {stats && stats.length > 0 && <KpiCards stats={stats} />}
      {selfUse && <CurveAnalysisBars selfUse={selfUse} />}
      {powerCurve && powerCurve.series.length > 0 && (
        <div className="solar-section">
          <h3 className="solar-h3">Power &amp; SOC — today</h3>
          <OverviewChart data={powerCurve} valueFmt={(v) => `${Math.round(v)}`} />
        </div>
      )}
      {comparison && comparison.series.length > 0 && (
        <div className="solar-section">
          <h3 className="solar-h3">Energy comparison</h3>
          <OverviewChart data={comparison} valueFmt={(v) => fmtEnergy(v)} />
        </div>
      )}
      {environmental && <EnvTiles env={environmental} />}
    </>
  );
}

/** The four KPI cards (Energy Generated / Consumption / Grid / Battery). */
function KpiCards({ stats }: { stats: EnergyStat[] }) {
  const byKind = (k: EnergyStat['kind']) => stats.find((s) => s.kind === k);
  const pv = byKind('pv');
  const load = byKind('load');
  const grid = byKind('grid');
  const batt = byKind('battery');
  return (
    <div className="solar-kpis">
      {pv && (
        <KpiCard title="Energy Generated" icon="▦">
          <KpiPrimary total={pv.totalKwh} today={pv.todayKwh} />
          {pv.selfUsePercentage != null && <KpiFoot label="Self-consumption" value={`${pv.selfUsePercentage}%`} />}
        </KpiCard>
      )}
      {load && (
        <KpiCard title="Energy Consumption" icon="▤">
          <KpiPrimary total={load.totalKwh} today={load.todayKwh} />
        </KpiCard>
      )}
      {grid && (
        <KpiCard title="Grid" icon="⇅">
          <KpiTwoRow aLabel="Import" a={grid.totalKwh} aToday={grid.todayKwh} bLabel="Export" b={grid.total2Kwh} bToday={grid.today2Kwh} />
        </KpiCard>
      )}
      {batt && (
        <KpiCard title="Battery" icon="🗲">
          <KpiTwoRow aLabel="Charge" a={batt.totalKwh} aToday={batt.todayKwh} bLabel="Discharge" b={batt.total2Kwh} bToday={batt.today2Kwh} />
        </KpiCard>
      )}
    </div>
  );
}
function KpiCard({ title, icon, children }: { title: string; icon: string; children: ReactNode }) {
  return (
    <div className="solar-kpi-card">
      <div className="solar-kpi-h"><span className="solar-kpi-ic">{icon}</span>{title}</div>
      {children}
    </div>
  );
}
function KpiPrimary({ total, today }: { total?: number; today?: number }) {
  return (
    <div className="solar-kpi-row">
      <span className="solar-kpi-big solar-mono">{fmtEnergy(total)}</span>
      {today != null && (
        <span className="solar-kpi-today"><span className="solar-kpi-d solar-mono">{fmtDelta(today)}</span><span className="solar-kpi-t">kWh today</span></span>
      )}
    </div>
  );
}
function KpiTwoRow({ aLabel, a, aToday, bLabel, b, bToday }: { aLabel: string; a?: number; aToday?: number; bLabel: string; b?: number; bToday?: number }) {
  return (
    <div className="solar-kpi-two">
      <div className="solar-kpi-line"><span className="solar-kpi-k">{aLabel}</span><span className="solar-kpi-vv solar-mono">{fmtEnergy(a)}</span>{aToday != null && <span className="solar-kpi-dd solar-mono">{fmtDelta(aToday)}</span>}</div>
      <div className="solar-kpi-line"><span className="solar-kpi-k">{bLabel}</span><span className="solar-kpi-vv solar-mono">{fmtEnergy(b)}</span>{bToday != null && <span className="solar-kpi-dd solar-mono">{fmtDelta(bToday)}</span>}</div>
    </div>
  );
}
function KpiFoot({ label, value }: { label: string; value: string }) {
  return <div className="solar-kpi-foot"><span>{label}</span><b className="solar-mono">{value}</b></div>;
}

/** Curve-analysis self-consumption / self-sufficiency bars. */
function CurveAnalysisBars({ selfUse }: { selfUse: NonNullable<StationOverview['selfUse']> }) {
  const pct = (r?: number) => (r != null ? Math.round(r * 1000) / 10 : undefined);
  const scRate = pct(selfUse.pvSelfConsumedRate); // PV used on-site
  const sellRate = pct(selfUse.pvSellRate);
  const ssRate = pct(selfUse.loadSelfConsumedRate); // load met on-site
  const buyRate = pct(selfUse.loadBuyRate);
  const unit = selfUse.unit || 'kWh';
  const hasPv = selfUse.pvEnergy != null;
  const hasLoad = selfUse.loadEnergy != null;
  if (!hasPv && !hasLoad) return null;
  return (
    <div className="solar-ca">
      {hasPv && (
        <div className="solar-ca-col">
          <div className="solar-ca-top"><span className="solar-ca-l">Energy Generated <b className="solar-mono">{selfUse.pvEnergy} {unit}</b></span>{scRate != null && <span className="solar-ca-r">Self-consumption <b>{scRate}%</b></span>}</div>
          <div className="solar-ca-sub"><span className="solar-dotm" style={{ background: 'var(--solar-batt)' }} />Self-consumed {selfUse.pvSelfConsumedEnergy ?? '—'} {unit}<span className="solar-ca-rt" style={{ color: 'var(--solar-grid)' }}>Export {selfUse.sellEnergy ?? '—'} {unit}</span></div>
          <div className="solar-bar"><i style={{ width: `${scRate ?? 0}%`, background: 'var(--solar-batt)' }} /><i style={{ width: `${sellRate ?? 0}%`, background: 'var(--solar-grid)' }} /></div>
          <div className="solar-ca-legend solar-mono"><span style={{ color: 'var(--solar-batt)' }}>{scRate ?? 0}%</span><span style={{ color: 'var(--solar-grid)' }}>{sellRate ?? 0}%</span></div>
        </div>
      )}
      {hasLoad && (
        <div className="solar-ca-col">
          <div className="solar-ca-top"><span className="solar-ca-l">Energy Consumption <b className="solar-mono">{selfUse.loadEnergy} {unit}</b></span>{ssRate != null && <span className="solar-ca-r">Self-sufficiency <b>{ssRate}%</b></span>}</div>
          <div className="solar-ca-sub"><span className="solar-dotm" style={{ background: 'var(--solar-batt)' }} />Self-sufficient {selfUse.loadSelfConsumedEnergy ?? '—'} {unit}<span className="solar-ca-rt" style={{ color: 'var(--flag)' }}>Import {selfUse.buyEnergy ?? '—'} {unit}</span></div>
          <div className="solar-bar"><i style={{ width: `${ssRate ?? 0}%`, background: 'var(--solar-batt)' }} /><i style={{ width: `${buyRate ?? 0}%`, background: 'var(--flag)' }} /></div>
          <div className="solar-ca-legend solar-mono"><span style={{ color: 'var(--solar-batt)' }}>{ssRate ?? 0}%</span><span style={{ color: 'var(--flag)' }}>{buyRate ?? 0}%</span></div>
        </div>
      )}
    </div>
  );
}

/** Environmental savings tiles. */
function EnvTiles({ env }: { env: NonNullable<StationOverview['environmental']> }) {
  const tiles = [
    { v: env.co2SavedT, unit: 't', label: 'CO₂ emissions reduced', icon: '🌥️' },
    { v: env.treesEquivalent, unit: 'm²', label: 'Equivalent tree planting', icon: '🌱' },
    { v: env.coalSavedT, unit: 't', label: 'Standard coal saved', icon: '🪨' },
  ].filter((t) => t.v != null);
  if (!tiles.length) return null;
  return (
    <div className="solar-envtiles">
      {tiles.map((t) => (
        <div className="solar-envtile" key={t.label}>
          <span className="solar-envtile-big solar-mono">{t.v}<em>{t.unit}</em></span>
          <span className="solar-envtile-l">{t.label}</span>
          <span className="solar-envtile-ic">{t.icon}</span>
        </div>
      ))}
    </div>
  );
}
