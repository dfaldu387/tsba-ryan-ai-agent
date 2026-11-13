// Fleet production analytics: monthly trend, production by plant, production by
// manufacturer and installed-capacity comparison. Granular per-day fleet history
// isn't exposed by the providers, so the ranked views pivot between the energy
// windows that are available (today / this month / lifetime).
import { useEffect, useMemo, useState } from 'react';
import { getSolarMonthlyProduction, type MonthlyProductionPoint, type SolarStation } from '../../api';
import { fmtCapacity, fmtEnergy } from './format';
import { RankBars, TrendBars, type RankDatum } from './charts';
import { EmptyState, SectionCard, SkeletonTiles, providerAccent } from './ui';
import type { SolarViewProps } from './types';

type Metric = 'daily' | 'monthly' | 'total';
const METRIC_LABEL: Record<Metric, string> = { daily: 'Today', monthly: 'This month', total: 'Lifetime' };
const METRIC_FIELD: Record<Metric, keyof SolarStation> = { daily: 'dailyEnergyKwh', monthly: 'monthlyEnergyKwh', total: 'totalEnergyKwh' };

export function AnalyticsView({ stations, providers, providerName }: SolarViewProps) {
  const [metric, setMetric] = useState<Metric>('daily');
  const [months, setMonths] = useState<MonthlyProductionPoint[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSolarMonthlyProduction(12)
      .then((r) => !cancelled && setMonths(r.months))
      .catch(() => !cancelled && setMonths([]));
    return () => { cancelled = true; };
  }, []);

  const val = (s: SolarStation) => (s[METRIC_FIELD[metric]] as number | undefined) ?? 0;

  const byPlant: RankDatum[] = useMemo(
    () => [...stations]
      .filter((s) => val(s) > 0)
      .sort((a, b) => val(b) - val(a))
      .slice(0, 12)
      .map((s) => ({ label: s.name, value: val(s), color: providerAccent(s.provider, providerName(s.provider)) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stations, metric],
  );

  const byManufacturer: RankDatum[] = useMemo(() => {
    const map = new Map<string, { sum: number; n: number }>();
    for (const s of stations) {
      const key = s.provider;
      const cur = map.get(key) ?? { sum: 0, n: 0 };
      cur.sum += val(s);
      cur.n += 1;
      map.set(key, cur);
    }
    return [...map.entries()]
      .map(([id, { sum, n }]) => ({ label: providerName(id), value: sum, sub: `${n} plant${n === 1 ? '' : 's'}`, color: providerAccent(id, providerName(id)) }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, metric, providers]);

  const byCapacity: RankDatum[] = useMemo(
    () => [...stations]
      .filter((s) => (s.capacityKw ?? 0) > 0)
      .sort((a, b) => (b.capacityKw ?? 0) - (a.capacityKw ?? 0))
      .slice(0, 12)
      .map((s) => ({ label: s.name, value: s.capacityKw ?? 0, color: providerAccent(s.provider, providerName(s.provider)) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stations],
  );

  return (
    <div className="col">
      <SectionCard title="Fleet production trend" eyebrow="Monthly, last 12 months">
        {months == null ? <SkeletonTiles count={1} />
          : months.length === 0 ? <EmptyState icon="analytics" title="No historical production recorded yet" hint="The fleet trend builds up from periodic snapshots — check back after a few days of monitoring." />
            : <TrendBars data={months.map((m) => ({ label: m.month.slice(5), value: m.kwh }))} valueFmt={(v) => fmtEnergy(v)} />}
      </SectionCard>

      <SectionCard
        title="Production by plant"
        eyebrow={`Ranked by ${METRIC_LABEL[metric].toLowerCase()}`}
        actions={
          <div className="solar-seg">
            {(['daily', 'monthly', 'total'] as Metric[]).map((m) => (
              <button key={m} type="button" className={`solar-seg-btn ${metric === m ? 'active' : ''}`} onClick={() => setMetric(m)}>
                {METRIC_LABEL[m]}
              </button>
            ))}
          </div>
        }
      >
        <RankBars data={byPlant} valueFmt={(v) => fmtEnergy(v)} />
      </SectionCard>

      <div className="solar-ov-grid">
        <SectionCard title="Production by manufacturer" eyebrow={METRIC_LABEL[metric]}>
          <RankBars data={byManufacturer} valueFmt={(v) => fmtEnergy(v)} />
        </SectionCard>

        <SectionCard title="Installed capacity" eyebrow="By plant (kWp)">
          <RankBars data={byCapacity} valueFmt={(v) => fmtCapacity(v)} />
        </SectionCard>
      </div>
    </div>
  );
}
