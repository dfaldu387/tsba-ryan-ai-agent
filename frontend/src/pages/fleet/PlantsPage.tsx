// Plant directory: paginated table (15 per page) with sticky header, sortable columns,
// column chooser, density toggle, status/provider filter chips and saved
// filters. Row → side drawer; "Open full page" → Plant 360.
import { ProviderErrors } from './ProviderErrors';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SolarStation, StationStatus } from '../../api';
import { useConsole } from '../../lib/console';
import type { AlertGroup } from '../../lib/alerts';
import { EMPTY, fmtInt, fmtKw, fmtKwh, fmtKwp, fmtPct, mask, staleness, toMs } from '../../lib/format';
import {
  Chip, Drawer, EmptyState, Icon, Menu, Pill, ProviderChip, RatioBar, RelTime, SearchInput, Segmented, SeverityPill,
  SkeletonRows, STATION_TONE, StatusDot, StatusPill, neverReported, usePref, usePaged, Pager, ErrorState,
} from '../../ui';

type ColKey = 'status' | 'plant' | 'provider' | 'capacity' | 'power' | 'today' | 'perf' | 'battery' | 'lastComm' | 'alerts';
type SortDir = 'asc' | 'desc';

const STATUS_RANK: Record<StationStatus, number> = { offline: 0, partial: 1, waiting: 2, unknown: 3, online: 4 };
const STATUSES: StationStatus[] = ['online', 'partial', 'offline', 'waiting', 'unknown'];

/** Specific yield today (kWh/kWp) relative to the fleet median → "performance vs fleet" %. */
function useFleetYield(stations: SolarStation[]) {
  return useMemo(() => {
    const ys = stations
      .filter((s) => s.status === 'online' && (s.capacityKw ?? 0) > 0 && s.dailyEnergyKwh != null)
      .map((s) => (s.dailyEnergyKwh as number) / (s.capacityKw as number))
      .sort((a, b) => a - b);
    const median = ys.length ? ys[Math.floor(ys.length / 2)] : null;
    return (s: SolarStation): number | null => {
      if (!median || median <= 0 || !s.capacityKw || s.dailyEnergyKwh == null) return null;
      return Math.min(150, ((s.dailyEnergyKwh / s.capacityKw) / median) * 100);
    };
  }, [stations]);
}

interface SavedFilter { name: string; status: StationStatus | 'all'; provider: string; q: string }

export function PlantsPage({ search }: { search: string }) {
  const { stations, providers, providerName, openGroups, fleetLoading, fleetError, refreshFleet, canSeePii, openPlant, overview } = useConsole();
  const params = useMemo(() => new URLSearchParams(search), [search]);

  const [status, setStatus] = useState<StationStatus | 'all'>((params.get('status') as StationStatus) || 'all');
  const [provider, setProvider] = useState(params.get('provider') || 'all');
  const [q, setQ] = useState('');
  const [sort, setSort] = usePref<{ key: ColKey; dir: SortDir }>('plants.sort', { key: 'status', dir: 'asc' });
  const [density, setDensity] = usePref<'comfortable' | 'compact'>('plants.density', 'comfortable');
  const [hidden, setHidden] = usePref<ColKey[]>('plants.hiddenCols', ['battery']);
  const [saved, setSaved] = usePref<SavedFilter[]>('plants.filters', []);
  const [active, setActive] = useState<SolarStation | null>(null);

  useEffect(() => {
    const s = params.get('status');
    if (s) setStatus(s as StationStatus);
  }, [params]);

  const perf = useFleetYield(stations);
  const alertsByPlant = useMemo(() => {
    const m = new Map<string, AlertGroup[]>();
    for (const g of openGroups) {
      const k = `${g.provider}:${g.plantId}`;
      m.set(k, [...(m.get(k) ?? []), g]);
    }
    return m;
  }, [openGroups]);
  const alertsFor = (s: SolarStation) => alertsByPlant.get(`${s.provider}:${s.id}`) ?? [];

  // Every connected platform gets a chip, even with 0 plants — hiding it made a
  // connected-but-empty account (GoodWe, Dyness) look like it wasn't there at all.
  const configured = (providers ?? []).filter((p) => p.configured || stations.some((s) => s.provider === p.id));
  const emptyProvider = provider !== 'all' && !stations.some((s) => s.provider === provider);
  // A slow platform (portal scrape, GoodWe) that hasn't answered yet is "stale",
  // not empty — say it's loading instead of blaming the account.
  const providerLoading = emptyProvider && (overview?.stale ?? []).includes(provider);
  const scoped = useMemo(() => (provider === 'all' ? stations : stations.filter((s) => s.provider === provider)), [stations, provider]);
  const statusCounts = useMemo(() => {
    const c = {} as Record<StationStatus, number>;
    for (const st of STATUSES) c[st] = scoped.filter((s) => s.status === st).length;
    return c;
  }, [scoped]);

  const rows = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = scoped.filter((s) => {
      if (status !== 'all' && s.status !== status) return false;
      if (terms.length) {
        const hay = `${s.name} ${s.id} ${canSeePii ? `${s.location ?? ''} ${s.owner ?? ''}` : ''} ${providerName(s.provider)}`.toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      return true;
    });
    const num = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? null : v);
    const val = (s: SolarStation): number | string | null => {
      switch (sort.key) {
        case 'status': return STATUS_RANK[s.status] * 1000 - alertsFor(s).length;
        case 'plant': return s.name.toLowerCase();
        case 'provider': return providerName(s.provider).toLowerCase();
        case 'capacity': return num(s.capacityKw);
        case 'power': return num(s.currentPowerW);
        case 'today': return num(s.dailyEnergyKwh);
        case 'perf': return perf(s);
        case 'battery': return num(s.batterySoc);
        case 'lastComm': return toMs(s.lastUpdate);
        case 'alerts': return alertsFor(s).length;
      }
    };
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1; // empties always last
      if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir || a.name.localeCompare(b.name);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, status, q, sort, perf, alertsByPlant, canSeePii]);

  // ── Columns ──
  const COLS: { key: ColKey; label: string; num?: boolean; render: (s: SolarStation) => ReactNode; fixed?: boolean }[] = [
    { key: 'status', label: 'Status', fixed: true, render: (s) => <StatusDot status={s.status} label /> },
    {
      key: 'plant', label: 'Plant', fixed: true,
      render: (s) => (
        <>
          <strong title={s.name}>{s.name}</strong>
          <span title={canSeePii ? s.location : undefined}>{s.location ? (canSeePii ? s.location : mask(s.location)) : <span className="c-empty-val">No address</span>}</span>
        </>
      ),
    },
    { key: 'provider', label: 'Provider', render: (s) => <ProviderChip id={s.provider} name={providerName(s.provider)} /> },
    { key: 'capacity', label: 'Capacity', num: true, render: (s) => fmtKwp(s.capacityKw) },
    { key: 'power', label: 'Now', num: true, render: (s) => (s.status === 'offline' ? <span className="c-empty-val">{EMPTY}</span> : fmtKw(s.currentPowerW, 1)) },
    { key: 'today', label: 'Today', num: true, render: (s) => fmtKwh(s.dailyEnergyKwh) },
    { key: 'perf', label: 'Perf. vs fleet', render: (s) => <RatioBar value={perf(s)} max={120} /> },
    { key: 'battery', label: 'Battery', num: true, render: (s) => fmtPct(s.batterySoc) },
    { key: 'lastComm', label: 'Last comm.', render: (s) => (neverReported(s) ? <span className="c-muted" title="This plant has never sent data to its provider">Never reported</span> : <RelTime t={s.lastUpdate} stale />) },
    {
      key: 'alerts', label: 'Alerts', num: true,
      render: (s) => {
        const a = alertsFor(s);
        if (!a.length) return <span className="c-empty-val">0</span>;
        const crit = a.some((g) => g.severity === 'critical');
        return <Pill tone={crit ? 'danger' : 'warning'}>{fmtInt(a.length)}</Pill>;
      },
    },
  ];
  const cols = COLS.filter((c) => c.fixed || !hidden.includes(c.key));

  // ── Pagination: 15 plants per page ──
  const paged = usePaged(rows, [status, provider, q, sort]);
  const { start, slice } = paged;

  const sortBy = (k: ColKey) =>
    setSort(sort.key === k ? { key: k, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: ['plant', 'provider', 'status'].includes(k) ? 'asc' : 'desc' });

  const saveFilter = () => {
    const name = window.prompt('Name this filter', [status !== 'all' ? STATION_TONE[status].label : '', provider !== 'all' ? providerName(provider) : '', q].filter(Boolean).join(' · ') || 'My filter');
    if (name) setSaved([...saved.filter((s) => s.name !== name), { name, status, provider, q }]);
  };

  const onRowKey = (e: React.KeyboardEvent<HTMLTableRowElement>, s: SolarStation) => {
    if (e.key === 'Enter') setActive(s);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const sib = (e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null;
      sib?.focus();
    }
  };

  const filtersActive = status !== 'all' || provider !== 'all' || q.trim() !== '';

  return (
    <div className="pg-plants">
      <ProviderErrors errors={overview?.errors ?? []} />
      <section className="c-section">
        <div className="c-toolbar">
          <SearchInput value={q} onChange={setQ} label="Search plants" placeholder={canSeePii ? 'Name, address, owner or ID…' : 'Name or ID…'} />
          <div className="c-chips" role="group" aria-label="Status filter">
            <Chip active={status === 'all'} onClick={() => setStatus('all')} count={scoped.length}>All</Chip>
            {STATUSES.filter((st) => statusCounts[st] > 0).map((st) => (
              <Chip key={st} tone={STATION_TONE[st].tone} active={status === st} onClick={() => setStatus(status === st ? 'all' : st)} count={statusCounts[st]}>
                {STATION_TONE[st].label}
              </Chip>
            ))}
          </div>
          <span className="c-spacer" />
          <Segmented label="Row density" value={density} onChange={setDensity}
            options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
          <ColumnChooser cols={COLS.filter((c) => !c.fixed).map((c) => ({ key: c.key, label: c.label }))} hidden={hidden} setHidden={setHidden} />
        </div>
        {(configured.length > 1 || saved.length > 0) && (
          <div className="c-toolbar pg-subbar">
            {configured.length > 1 && (
              <div className="c-chips" role="group" aria-label="Provider filter">
                <Chip active={provider === 'all'} onClick={() => setProvider('all')}>All providers</Chip>
                {configured.map((p) => (
                  <Chip key={p.id} active={provider === p.id} onClick={() => setProvider(provider === p.id ? 'all' : p.id)} count={stations.filter((s) => s.provider === p.id).length}>{p.name}</Chip>
                ))}
              </div>
            )}
            <span className="c-spacer" />
            {saved.map((f) => (
              <span key={f.name} className="pg-saved">
                <button type="button" onClick={() => { setStatus(f.status); setProvider(f.provider); setQ(f.q); }}><Icon name="sliders" size={14} />{f.name}</button>
                <button type="button" className="pg-saved-x" aria-label={`Delete filter ${f.name}`} onClick={() => setSaved(saved.filter((x) => x.name !== f.name))}><Icon name="x" size={12} /></button>
              </span>
            ))}
            {filtersActive && <button type="button" className="c-btn sm ghost" onClick={saveFilter}><Icon name="plus" size={14} /> Save filter</button>}
          </div>
        )}

        {fleetLoading ? (
          <SkeletonRows rows={10} cols={6} />
        ) : stations.length === 0 && fleetError ? (
          <ErrorState title="Monitoring data unavailable" detail={fleetError} onRetry={() => void refreshFleet()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={stations.length && !emptyProvider ? 'search' : 'plant'}
            title={providerLoading ? `Loading plants from ${providerName(provider)}…` : emptyProvider ? `No plants on ${providerName(provider)}` : stations.length ? 'No plants match' : 'No plants on the connected accounts'}
            hint={providerLoading ? 'This platform is slow to answer after a restart. Its plants appear here automatically within a minute or two.' : emptyProvider ? 'This platform is connected, but its account returned no plants. Check the account has sites shared with it.' : stations.length ? 'Clear the search or a filter.' : undefined}
            action={filtersActive ? <button type="button" className="c-btn sm" onClick={() => { setStatus('all'); setProvider('all'); setQ(''); }}>Clear filters</button> : undefined}
          />
        ) : (
          <div className="c-tablewrap">
            <table className={`c-table pg-plant-table ${density === 'compact' ? 'dense' : ''}`} aria-rowcount={rows.length + 1}>
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c.key} className={c.num ? 'num' : undefined}
                      aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => sortBy(c.key)}>
                        {c.label}
                        {sort.key === c.key && <span aria-hidden="true">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
                      </button>
                    </th>
                  ))}
                  <th className="pg-act-col"><span className="c-sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {slice.map((s, i) => (
                  <tr key={`${s.provider}:${s.id}`} tabIndex={0} aria-rowindex={start + i + 2}
                    aria-selected={active?.id === s.id && active.provider === s.provider}
                    onClick={() => setActive(s)} onKeyDown={(e) => onRowKey(e, s)}>
                    {cols.map((c) => (
                      <td key={c.key} className={c.key === 'plant' ? 'name' : c.num ? 'num' : undefined} data-label={c.key === 'plant' ? undefined : c.label}>{c.render(s)}</td>
                    ))}
                    <td className="pg-act-col">
                      {/* Straight to the full plant page (Overview tab); the row itself still opens the quick drawer. */}
                      <button type="button" className="c-iconbtn" title="View details" aria-label={`View ${s.name} details`}
                        onClick={(e) => { e.stopPropagation(); openPlant(s, { tab: 'overview' }); }}
                        onKeyDown={(e) => e.stopPropagation()}>
                        <Icon name="send" size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager paged={paged} noun={filtersActive ? 'matching plant' : 'plant'}
          extra={<span className="c-muted c-hide-sm">Perf. vs fleet = today’s kWh per kWp compared with the fleet median.</span>} />
      </section>

      <PlantDrawer station={active} onClose={() => setActive(null)} alerts={active ? alertsFor(active) : []}
        perf={active ? perf(active) : null} onOpenFull={(tab) => { if (active) openPlant(active, { tab }); }} />
    </div>
  );
}

function ColumnChooser({ cols, hidden, setHidden }: { cols: { key: ColKey; label: string }[]; hidden: ColKey[]; setHidden: (v: ColKey[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); window.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div className="c-menu" ref={ref}>
      <button type="button" className="c-btn sm" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="columns" size={14} /> Columns
      </button>
      {open && (
        <div className="c-menu-pop right">
          <fieldset className="c-colpicker" style={{ border: 0, margin: 0 }}>
            <legend className="c-sr">Visible columns</legend>
            {cols.map((c) => (
              <label key={c.key}>
                <input type="checkbox" className="c-checkbox" checked={!hidden.includes(c.key)}
                  onChange={() => setHidden(hidden.includes(c.key) ? hidden.filter((h) => h !== c.key) : [...hidden, c.key])} />
                {c.label}
              </label>
            ))}
          </fieldset>
        </div>
      )}
    </div>
  );
}

export function PlantDrawer({ station, onClose, alerts, perf, onOpenFull }: {
  station: SolarStation | null; onClose: () => void; alerts: AlertGroup[]; perf: number | null; onOpenFull: (tab?: string) => void;
}) {
  const { providerName, canSeePii } = useConsole();
  if (!station) return null;
  const s = station;
  const st = staleness(s.lastUpdate);
  return (
    <Drawer
      open
      onClose={onClose}
      title={s.name}
      sub={<><StatusPill status={s.status} /><ProviderChip id={s.provider} name={providerName(s.provider)} />{s.location && <span>{canSeePii ? s.location : mask(s.location)}</span>}</>}
      footer={
        <>
          <button type="button" className="c-btn primary" onClick={() => onOpenFull()}>Open full page <Icon name="chevron" size={14} /></button>
          <button type="button" className="c-btn" onClick={() => onOpenFull('ai')}><Icon name="ai" size={14} /> Ask AI about this plant</button>
        </>
      }
    >
      {neverReported(s) && (
        <div className="c-banner t-warning" role="note">
          <Icon name="alert" size={16} />
          <span>{providerName(s.provider)} has never sent data for this plant. It usually means no datalogger or inverter is linked to it there — check the plant in the {providerName(s.provider)} portal.</span>
        </div>
      )}
      <div className="pg-drawer-kpis">
        <div><span>Now</span><b>{s.status === 'offline' ? EMPTY : fmtKw(s.currentPowerW, 2)}</b></div>
        <div><span>Today</span><b>{fmtKwh(s.dailyEnergyKwh)}</b></div>
        <div><span>Capacity</span><b>{fmtKwp(s.capacityKw)}</b></div>
        <div><span>Perf. vs fleet</span><b>{perf == null ? EMPTY : `${Math.round(perf)}%`}</b></div>
      </div>
      <dl className="c-dl">
        <div><dt>Last communication</dt><dd className={`c-stale s-${st}`}>{neverReported(s) ? 'Never' : <RelTime t={s.lastUpdate} stale />}</dd></div>
        <div><dt>This month</dt><dd>{fmtKwh(s.monthlyEnergyKwh)}</dd></div>
        <div><dt>Lifetime</dt><dd>{fmtKwh(s.totalEnergyKwh)}</dd></div>
        <div><dt>Battery</dt><dd>{fmtPct(s.batterySoc)}</dd></div>
        {s.owner && <div><dt>Owner</dt><dd>{canSeePii ? s.owner : mask(s.owner)}</dd></div>}
        <div><dt>Plant ID</dt><dd><code className="c-mono">{s.id}</code></dd></div>
      </dl>
      <div>
        <h3 className="c-h3">Open alerts ({fmtInt(alerts.length)})</h3>
        {alerts.length === 0 ? (
          <p className="c-muted">No open alerts for this plant.</p>
        ) : (
          <ul className="pg-drawer-alerts">
            {alerts.slice(0, 6).map((g) => (
              <li key={g.key}>
                <SeverityPill severity={g.severity} />
                <span className="c-trunc" title={g.fault}>{g.fault}</span>
                {g.count > 1 && <span className="c-muted">×{fmtInt(g.count)}</span>}
              </li>
            ))}
            {alerts.length > 6 && <li><button type="button" className="c-link" onClick={() => onOpenFull('alerts')}>All {fmtInt(alerts.length)} alerts →</button></li>}
          </ul>
        )}
      </div>
      <Menu label="More" trigger={<><Icon name="more" size={14} /> More</>} align="left" items={[
        { label: 'Devices', icon: 'monitor', onSelect: () => onOpenFull('devices') },
        { label: 'Documents', icon: 'doc', onSelect: () => onOpenFull('documents') },
        { label: 'Support history', icon: 'inbox', onSelect: () => onOpenFull('history') },
        { label: 'Notes & contact', icon: 'user', onSelect: () => onOpenFull('notes') },
      ]} />
    </Drawer>
  );
}
