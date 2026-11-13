// Provider integration centre. Statuses are derived from the real backend
// configuration (configured flag), the live overview (plant counts + per-provider
// reachability errors) and the last successful fleet refresh — never assumed.
import { useMemo } from 'react';
import type { SolarProviderInfo } from '../../api';
import { EmptyState, SectionCard, providerAccent, providerInitials } from './ui';
import type { SolarViewProps } from './types';

type IntegStatus = 'connected' | 'no-plants' | 'pending' | 'error' | 'not-configured';
const STATUS_LABEL: Record<IntegStatus, string> = {
  connected: 'Connected',
  'no-plants': 'Connected · no plants',
  pending: 'Awaiting verification',
  error: 'Connection error',
  'not-configured': 'Not configured',
};
const STATUS_TONE: Record<IntegStatus, string> = { connected: 'ok', 'no-plants': 'mid', pending: 'mid', error: 'flag', 'not-configured': 'muted' };

export function IntegrationsView({ providers, stations, overview, lastUpdated, goTo }: SolarViewProps) {
  const plantCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of stations) m.set(s.provider, (m.get(s.provider) ?? 0) + 1);
    return m;
  }, [stations]);

  const errorFor = (id: string) => overview?.errors.find((e) => e.provider === id)?.error;

  const unavailable = new Set(overview?.unavailable ?? []);
  const statusOf = (p: SolarProviderInfo): IntegStatus => {
    if (!p.configured) return 'not-configured';
    if (errorFor(p.id)) return 'error';
    if ((plantCounts.get(p.id) ?? 0) > 0) return 'connected';
    if (unavailable.has(p.id)) return 'pending';
    return 'no-plants';
  };

  const connectedCount = providers.filter((p) => p.configured).length;
  const sorted = [...providers].sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));

  return (
    <div className="col">
      <SectionCard title="Provider integrations" eyebrow={`${connectedCount} of ${providers.length} configured`}>
        {providers.length === 0 ? (
          <EmptyState icon="integrations" title="No providers available" />
        ) : (
          <div className="solar-integ-grid">
            {sorted.map((p) => {
              const st = statusOf(p);
              const accent = providerAccent(p.id, p.name);
              const plants = plantCounts.get(p.id) ?? 0;
              const err = errorFor(p.id);
              return (
                <div className="solar-integ-card" key={p.id} style={{ ['--integ-accent' as string]: accent }}>
                  <div className="solar-integ-top">
                    <span className="solar-integ-logo" style={{ background: accent }}>{providerInitials(p.name)}</span>
                    <div className="solar-integ-id">
                      <strong>{p.name}</strong>
                      <span className={`solar-badge ${STATUS_TONE[st]}`}>{STATUS_LABEL[st]}</span>
                    </div>
                  </div>
                  <dl className="solar-integ-meta">
                    <div><dt>Connected plants</dt><dd className="solar-mono">{p.configured ? plants : '—'}</dd></div>
                    <div><dt>Last sync</dt><dd>{p.configured && lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : '—'}</dd></div>
                  </dl>
                  {err && <p className="solar-integ-err">{err}</p>}
                  {st === 'pending' && <p className="solar-integ-hint">Integration wired, but it isn’t returning data yet — the portal session likely needs to be re-captured.</p>}
                  {!p.configured && <p className="solar-integ-hint">Add this provider’s credentials to the server <code>.env</code> and restart the backend.</p>}
                  {p.configured && plants > 0 && (
                    <button type="button" className="ghost solar-integ-act" onClick={() => goTo('plants')}>View {plants} plant{plants === 1 ? '' : 's'} →</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
