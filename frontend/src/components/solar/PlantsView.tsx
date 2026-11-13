// Plant directory: a searchable, filterable, sortable status table across all
// providers. Row → plant detail. Stacks into cards on narrow screens (CSS).
import { useEffect, useMemo, useState } from 'react';
import type { SolarStation, StationStatus } from '../../api';
import { fmtAgo, fmtCapacity, fmtEnergy, fmtPower, STATUS_META, STATUS_ORDER } from './format';
import { EmptyState, ICON, SectionCard, StatusBadge } from './ui';
import type { SolarViewProps } from './types';

type SortKey = 'default' | 'power' | 'daily' | 'capacity' | 'name' | 'status';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'default', label: 'Default order' },
  { value: 'power', label: 'Power (high → low)' },
  { value: 'daily', label: 'Today’s energy (high → low)' },
  { value: 'capacity', label: 'Capacity (high → low)' },
  { value: 'status', label: 'Status (issues first)' },
  { value: 'name', label: 'Name (A → Z)' },
];

const STATUS_RANK: Record<StationStatus, number> = { offline: 0, partial: 1, waiting: 2, unknown: 3, online: 4 };

export function PlantsView({ stations, providers, providerName, openStation }: SolarViewProps) {
  const [provider, setProvider] = useState('all');
  const [status, setStatus] = useState<'all' | StationStatus>('all');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('default');
  const [limit, setLimit] = useState(150);

  const configured = providers.filter((p) => p.configured);

  const scoped = useMemo(
    () => (provider === 'all' ? stations : stations.filter((s) => s.provider === provider)),
    [stations, provider],
  );

  const statusCounts = useMemo(
    () => STATUS_ORDER.map((st) => ({ st, n: scoped.filter((s) => s.status === st).length })).filter((x) => x.n > 0),
    [scoped],
  );

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = scoped.filter((s) => {
      if (status !== 'all' && s.status !== status) return false;
      if (q && !`${s.name} ${s.location ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const num = (v?: number) => (v == null || Number.isNaN(v) ? -Infinity : v);
    const sorted = [...list];
    switch (sortBy) {
      case 'power': sorted.sort((a, b) => num(b.currentPowerW) - num(a.currentPowerW)); break;
      case 'daily': sorted.sort((a, b) => num(b.dailyEnergyKwh) - num(a.dailyEnergyKwh)); break;
      case 'capacity': sorted.sort((a, b) => num(b.capacityKw) - num(a.capacityKw)); break;
      case 'status': sorted.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]); break;
      case 'name': sorted.sort((a, b) => a.name.localeCompare(b.name)); break;
      default: break;
    }
    return sorted;
  }, [scoped, status, search, sortBy]);

  const filtersActive = status !== 'all' || search.trim() !== '';
  useEffect(() => setLimit(150), [provider, status, search, sortBy]);
  const visible = shown.slice(0, limit);

  return (
    <div className="col">
      {configured.length > 1 && (
        <div className="solar-filter">
          <button type="button" className={`solar-chip ${provider === 'all' ? 'active' : ''}`} onClick={() => setProvider('all')}>
            All ({stations.length})
          </button>
          {configured.map((p) => (
            <button key={p.id} type="button" className={`solar-chip ${provider === p.id ? 'active' : ''}`} onClick={() => setProvider(p.id)}>
              {p.name} ({stations.filter((s) => s.provider === p.id).length})
            </button>
          ))}
        </div>
      )}

      <SectionCard
        title="Plants"
        eyebrow={`${filtersActive ? `${shown.length} of ${scoped.length}` : `${scoped.length} total`} · ${shown.filter((s) => s.status === 'online').length} online`}
      >
        <div className="solar-toolbar">
          <div className="solar-search">
            <span className="solar-search-ico">{ICON.search}</span>
            <input
              type="search"
              className="solar-search-input"
              placeholder="Search by name or location…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search plants"
            />
            {search && <button type="button" className="solar-search-clear" onClick={() => setSearch('')} aria-label="Clear search">×</button>}
          </div>

          {statusCounts.length > 1 && (
            <div className="solar-status-chips">
              <button type="button" className={`solar-chip sm ${status === 'all' ? 'active' : ''}`} onClick={() => setStatus('all')}>
                All ({scoped.length})
              </button>
              {statusCounts.map(({ st, n }) => (
                <button key={st} type="button" className={`solar-chip sm ${status === st ? 'active' : ''}`} onClick={() => setStatus(st)}>
                  {STATUS_META[st].label} ({n})
                </button>
              ))}
            </div>
          )}

          <div className="solar-toolbar-right">
            <label className="solar-sort">
              <span>Sort</span>
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)}>
                {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>
        </div>

        {shown.length === 0 ? (
          <EmptyState
            icon="plants"
            title={scoped.length === 0 ? 'No plants on the connected account(s)' : 'No plants match the filters'}
            hint={scoped.length === 0 ? undefined : 'Try clearing the search or status filter.'}
          />
        ) : (
          <div className="solar-table-wrap">
            <table className="solar-table solar-plants-table">
              <thead>
                <tr>
                  <th>Plant</th>
                  <th>Location</th>
                  <th>Manufacturer</th>
                  <th className="num">Capacity</th>
                  <th className="num">Current</th>
                  <th className="num">Today</th>
                  <th>Status</th>
                  <th className="num">Last comm.</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visible.map((s: SolarStation) => (
                  <tr key={`${s.provider}:${s.id}`} className="solar-prow" onClick={() => openStation(s)} tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && openStation(s)}>
                    <td data-label="Plant"><span className="solar-prow-name">{s.name}</span></td>
                    <td data-label="Location">{s.location || '—'}</td>
                    <td data-label="Manufacturer"><span className="solar-provider-tag">{providerName(s.provider)}</span></td>
                    <td data-label="Capacity" className="num solar-mono">{fmtCapacity(s.capacityKw)}</td>
                    <td data-label="Current" className="num solar-mono">{fmtPower(s.currentPowerW)}</td>
                    <td data-label="Today" className="num solar-mono">{fmtEnergy(s.dailyEnergyKwh)}</td>
                    <td data-label="Status"><StatusBadge status={s.status} /></td>
                    <td data-label="Last comm." className="num">{fmtAgo(s.lastUpdate)}</td>
                    <td className="solar-prow-act"><span className="solar-prow-view">View {ICON.chevron}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length > visible.length && (
              <div className="solar-showmore">
                <span>Showing {visible.length} of {shown.length}</span>
                <button type="button" className="ghost" onClick={() => setLimit((l) => l + 200)}>Show more</button>
              </div>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
