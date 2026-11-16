// Fleet device inventory. Providers only expose device lists per plant (serial,
// type, online state), so fleet totals come from the alert scan and each
// plant's devices load on demand when its row is expanded. Serials already seen
// in alerts are searchable before anything is loaded.
import { Fragment, useMemo, useState } from 'react';
import { AuthError, getSolarStationDetail, type SolarDevice, type SolarStation, type StationStatus } from '../../api';
import { useConsole } from '../../lib/console';
import type { AlertGroup } from '../../lib/alerts';
import { fmtInt, fmtPct, mask } from '../../lib/format';
import {
  Chip, DeviceStatePill, EmptyState, Icon, KpiTile, Pill, ProviderChip, RelTime, SearchInput, SeverityPill, SkeletonRows, StatusPill, usePaged, Pager,
} from '../../ui';

interface DeviceState { loading: boolean; error?: string; devices?: SolarDevice[] }
type Filter = 'all' | 'issues' | 'online';

const STATUS_RANK: Record<StationStatus, number> = { offline: 0, partial: 1, waiting: 2, unknown: 3, online: 4 };

export function DevicesPage() {
  const { stations, alerts, alertsLoading, providers, providerName, openGroups, openPlant, canSeePii, fleetLoading } = useConsole();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [provider, setProvider] = useState('all');
  const [open, setOpen] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, DeviceState>>({});

  const total = alerts?.totalDevices;
  const online = alerts?.onlineDevices;
  const offline = total != null && online != null ? Math.max(0, total - online) : undefined;

  const key = (s: SolarStation) => `${s.provider}:${s.id}`;

  const alertsByPlant = useMemo(() => {
    const m = new Map<string, AlertGroup[]>();
    for (const g of openGroups) {
      const k = `${g.provider}:${g.plantId}`;
      m.set(k, [...(m.get(k) ?? []), g]);
    }
    return m;
  }, [openGroups]);

  const deviceAlertPlants = useMemo(
    () => new Set(openGroups.filter((g) => g.devices.length > 0 || g.category === 'comms' || g.category === 'device').map((g) => `${g.provider}:${g.plantId}`)),
    [openGroups],
  );

  // Serials known without a detail call: from alerts and anything already loaded.
  const serialsByPlant = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const g of openGroups) {
      const k = `${g.provider}:${g.plantId}`;
      m.set(k, [...(m.get(k) ?? []), ...g.devices]);
    }
    for (const [k, st] of Object.entries(cache)) {
      if (st.devices) m.set(k, [...(m.get(k) ?? []), ...st.devices.map((d) => d.sn)]);
    }
    return m;
  }, [openGroups, cache]);

  const usedProviders = useMemo(() => {
    const ids = new Set(stations.map((s) => s.provider));
    return (providers ?? []).filter((p) => p.configured || ids.has(p.id)); // connected platforms stay listed even with 0 plants
  }, [stations, providers]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return stations
      .filter((s) => provider === 'all' || s.provider === provider)
      .filter((s) => {
        if (filter === 'online') return s.status === 'online';
        if (filter === 'issues') return s.status === 'offline' || s.status === 'partial' || deviceAlertPlants.has(key(s));
        return true;
      })
      .filter((s) => {
        if (!needle) return true;
        const hay = `${s.name} ${s.id} ${canSeePii ? s.location ?? '' : ''} ${(serialsByPlant.get(key(s)) ?? []).join(' ')}`.toLowerCase();
        return hay.includes(needle);
      })
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]
        || (alertsByPlant.get(key(b))?.length ?? 0) - (alertsByPlant.get(key(a))?.length ?? 0)
        || a.name.localeCompare(b.name));
  }, [stations, provider, filter, q, deviceAlertPlants, serialsByPlant, alertsByPlant, canSeePii]);

  const issueCount = useMemo(
    () => stations.filter((s) => s.status === 'offline' || s.status === 'partial' || deviceAlertPlants.has(key(s))).length,
    [stations, deviceAlertPlants],
  );

  const load = (s: SolarStation) => {
    const k = key(s);
    if (cache[k]?.devices || cache[k]?.loading) return;
    setCache((p) => ({ ...p, [k]: { loading: true } }));
    getSolarStationDetail(s.provider, s.id)
      .then((d) => setCache((p) => ({ ...p, [k]: { loading: false, devices: d.devices ?? [] } })))
      .catch((err) => {
        if (err instanceof AuthError) return;
        setCache((p) => ({ ...p, [k]: { loading: false, error: 'Couldn’t load devices from the provider.' } }));
      });
  };

  const toggle = (s: SolarStation) => {
    const k = key(s);
    setOpen((cur) => (cur === k ? null : k));
    load(s);
  };

  const needle = q.trim().toLowerCase();
  const paged = usePaged(rows, [q, filter, provider]);
  const visible = paged.slice;

  return (
    <div className="pg-devices">
      <div className="c-kpis">
        <KpiTile icon="monitor" label="Devices reported" loading={alertsLoading && total == null}
          value={total != null ? fmtInt(total) : '—'}
          sub="From providers with a device API" />
        <KpiTile icon="check" label="Communicating" tone="success" loading={alertsLoading && online == null}
          value={online != null ? fmtInt(online) : '—'}
          sub={total ? `${fmtPct((online ?? 0) / total * 100)} of devices` : undefined} />
        <KpiTile icon="offline" label="Not communicating" tone={offline ? 'danger' : 'neutral'} loading={alertsLoading && offline == null}
          value={offline != null ? fmtInt(offline) : '—'}
          sub={total ? `${fmtPct((offline ?? 0) / total * 100)} of devices` : undefined} />
        <KpiTile icon="plant" label="Plants needing a look" tone={issueCount ? 'warning' : 'neutral'}
          value={fmtInt(issueCount)} sub={`of ${fmtInt(stations.length)} plants`}
          onClick={() => setFilter('issues')} />
      </div>

      <section className="c-section">
        <div className="c-toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Plant, plant ID or serial…" label="Search plants or serials" />
          <div className="c-chips" role="group" aria-label="Filter">
            <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={stations.length}>All plants</Chip>
            <Chip active={filter === 'issues'} onClick={() => setFilter('issues')} tone="warning" count={issueCount}>Needs a look</Chip>
            <Chip active={filter === 'online'} onClick={() => setFilter('online')} tone="success"
              count={stations.filter((s) => s.status === 'online').length}>Online</Chip>
          </div>
          <span className="c-spacer" />
          <select className="c-select" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
            <option value="all">All providers</option>
            {usedProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <p className="pg-devices-hint c-muted">
          <Icon name="clock" size={14} /> Device lists load from the provider when you open a plant. Serials already reported in alerts are searchable straight away.
        </p>

        {fleetLoading && stations.length === 0 ? <SkeletonRows rows={8} cols={6} /> : rows.length === 0 ? (
          <EmptyState icon="search" title="No plants match" hint="Try another filter, or search by the full serial number."
            action={<button type="button" className="c-btn sm" onClick={() => { setQ(''); setFilter('all'); setProvider('all'); }}>Clear filters</button>} />
        ) : (
          <div className="c-tablewrap">
            <table className="c-table pg-dev-table">
              <thead>
                <tr>
                  <th aria-label="Expand" className="pg-dev-chev" />
                  <th>Plant</th>
                  <th>Provider</th>
                  <th>Status</th>
                  <th className="num">Devices</th>
                  <th className="num">Open alerts</th>
                  <th>Last data</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => {
                  const k = key(s);
                  const isOpen = open === k;
                  const st = cache[k];
                  const groups = alertsByPlant.get(k) ?? [];
                  const offlineDevs = st?.devices?.filter((d) => d.online === false).length ?? 0;
                  const serialHit = needle && (serialsByPlant.get(k) ?? []).find((sn) => sn.toLowerCase().includes(needle));
                  return (
                    <Fragment key={k}>
                      <tr aria-expanded={isOpen} tabIndex={0} onClick={() => toggle(s)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(s); } }}>
                        <td className="pg-dev-chev"><span className={`pg-chev ${isOpen ? 'open' : ''}`}><Icon name="chevron" size={16} /></span></td>
                        <td className="name">
                          <strong title={s.name}>{s.name}</strong>
                          <span>{serialHit ? <>Serial match <code className="c-mono">{serialHit}</code></> : canSeePii ? s.location || s.id : mask(s.location) || s.id}</span>
                        </td>
                        <td className="dv-prov"><ProviderChip id={s.provider} name={providerName(s.provider)} /></td>
                        <td className="dv-status"><StatusPill status={s.status} /></td>
                        <td className="num dv-devs" data-label="Devices">
                          {st?.loading ? <span className="c-muted">Loading…</span>
                            : st?.devices ? (
                              <>
                                {fmtInt(st.devices.length)}
                                {offlineDevs > 0 && <Pill tone="danger">{fmtInt(offlineDevs)} offline</Pill>}
                              </>
                            ) : <span className="c-empty-val" title="Open the plant to load its devices">—</span>}
                        </td>
                        <td className="num dv-alerts" data-label="Open alerts">{groups.length ? <Pill tone={groups.some((g) => g.severity === 'critical') ? 'danger' : 'warning'}>{fmtInt(groups.length)}</Pill> : <span className="c-empty-val">0</span>}</td>
                        <td className="dv-when" data-label="Last data"><RelTime t={s.lastUpdate} stale /></td>
                        <td className="pg-actions dv-act" onClick={(e) => e.stopPropagation()}>
                          <button type="button" className="c-btn sm ghost" onClick={() => openPlant(s, { tab: 'devices' })}>Open plant</button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="pg-expand">
                          <td colSpan={8}>
                            <DeviceList state={st} groups={groups} onRetry={() => { setCache((p) => { const n = { ...p }; delete n[k]; return n; }); setTimeout(() => load(s)); }} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager paged={paged} noun="plant" />
      </section>
    </div>
  );
}

function DeviceList({ state, groups, onRetry }: { state?: DeviceState; groups: AlertGroup[]; onRetry: () => void }) {
  if (!state || state.loading) return <SkeletonRows rows={2} cols={4} />;
  if (state.error) {
    return (
      <div className="pg-dev-err" role="alert">
        <Icon name="alert" size={16} /> {state.error}
        <button type="button" className="c-btn sm" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  const devices = state.devices ?? [];
  if (devices.length === 0) return <p className="c-muted pg-dev-none">This provider doesn’t expose a device list for this plant.</p>;
  const alertsFor = (sn: string) => groups.filter((g) => g.devices.includes(sn));
  return (
    <table className="pg-dev-sub">
      <thead><tr><th>Serial</th><th>Type</th><th>State</th><th>Open alerts</th></tr></thead>
      <tbody>
        {devices.map((d, i) => {
          const ga = d.sn ? alertsFor(d.sn) : [];
          return (
            <tr key={`${d.sn}:${d.type ?? ''}:${i}`}>
              <td><code className="c-mono">{d.sn || '—'}</code></td>
              <td>{d.type || <span className="c-empty-val">—</span>}</td>
              <td><DeviceStatePill device={d} /></td>
              <td>
                {ga.length === 0 ? <span className="c-empty-val">—</span> : (
                  <span className="pg-dev-alerts">
                    {ga.slice(0, 2).map((g) => <span key={g.key}><SeverityPill severity={g.severity} /> {g.fault}</span>)}
                    {ga.length > 2 && <span className="c-muted">+{ga.length - 2} more</span>}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
