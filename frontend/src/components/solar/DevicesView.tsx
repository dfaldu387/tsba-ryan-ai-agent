// Fleet device inventory. The providers only expose device lists per plant (and
// only serial / type / online state — no live power or temperature), so this
// aggregates lazily: fleet totals come from the alert scan, and each plant's
// device list is fetched on demand when expanded.
import { useMemo, useState } from 'react';
import { AuthError, getSolarStationDetail, type SolarDevice, type SolarStation } from '../../api';
import { EmptyState, ICON, KpiTile, SectionCard, SkeletonRows } from './ui';
import type { SolarViewProps } from './types';

interface DeviceState {
  loading: boolean;
  error?: string;
  devices?: SolarDevice[];
}

export function DevicesView({ stations, alerts, providerName, openStation }: SolarViewProps) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [cache, setCache] = useState<Record<string, DeviceState>>({});

  const total = alerts?.totalDevices;
  const online = alerts?.onlineDevices;
  const offline = total != null && online != null ? Math.max(0, total - online) : undefined;

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return stations;
    return stations.filter((s) => `${s.name} ${s.location ?? ''}`.toLowerCase().includes(q));
  }, [stations, search]);

  const key = (s: SolarStation) => `${s.provider}:${s.id}`;

  const toggle = (s: SolarStation) => {
    const k = key(s);
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
    if (!cache[k]) {
      setCache((prev) => ({ ...prev, [k]: { loading: true } }));
      getSolarStationDetail(s.provider, s.id)
        .then((d) => setCache((prev) => ({ ...prev, [k]: { loading: false, devices: d.devices } })))
        .catch((err) => {
          if (err instanceof AuthError) return;
          setCache((prev) => ({ ...prev, [k]: { loading: false, error: 'Couldn’t load devices.' } }));
        });
    }
  };

  return (
    <div className="col">
      <div className="solar-tiles">
        <KpiTile icon="devices" label="Devices (fleet)" value={total != null ? String(total) : '—'} title="Total devices reported across providers with a device API." />
        <KpiTile icon="online" label="Communicating" value={online != null ? String(online) : '—'} tone="accent" />
        <KpiTile icon="alerts" label="Not communicating" value={offline != null ? String(offline) : '—'} />
        <KpiTile icon="plants" label="Plants" value={String(stations.length)} />
      </div>

      <SectionCard title="Device inventory" eyebrow="Expand a plant to load its devices">
        <div className="solar-toolbar">
          <div className="solar-search">
            <span className="solar-search-ico">{ICON.search}</span>
            <input type="search" className="solar-search-input" placeholder="Find a plant…" value={search}
              onChange={(e) => setSearch(e.target.value)} aria-label="Find a plant" />
            {search && <button type="button" className="solar-search-clear" onClick={() => setSearch('')} aria-label="Clear">×</button>}
          </div>
        </div>

        {shown.length === 0 ? (
          <EmptyState icon="devices" title="No plants match" />
        ) : (
          <div className="solar-acc">
            {shown.map((s) => {
              const k = key(s);
              const isOpen = open.has(k);
              const st = cache[k];
              return (
                <div className={`solar-acc-item ${isOpen ? 'open' : ''}`} key={k}>
                  <button type="button" className="solar-acc-head" onClick={() => toggle(s)} aria-expanded={isOpen}>
                    <span className={`solar-acc-chev ${isOpen ? 'open' : ''}`}>{ICON.chevron}</span>
                    <span className="solar-acc-name">{s.name}</span>
                    <span className="solar-provider-tag">{providerName(s.provider)}</span>
                    {st?.devices && <span className="solar-acc-count">{st.devices.length} device{st.devices.length === 1 ? '' : 's'}</span>}
                  </button>
                  {isOpen && (
                    <div className="solar-acc-body">
                      {st?.loading && <SkeletonRows rows={2} />}
                      {st?.error && <span className="err">{st.error}</span>}
                      {st?.devices && (st.devices.length === 0 ? (
                        <p className="solar-empty">No device data exposed by this provider.</p>
                      ) : (
                        <div className="solar-table-wrap">
                          <table className="solar-table">
                            <thead><tr><th>Serial</th><th>Type</th><th>State</th></tr></thead>
                            <tbody>
                              {st.devices.map((d, i) => (
                                <tr key={d.sn || i}>
                                  <td data-label="Serial" className="solar-mono">{d.sn || '—'}</td>
                                  <td data-label="Type">{d.type || '—'}</td>
                                  <td data-label="State"><span className={`solar-dot ${d.online ? 'ok' : 'flag'}`} />{d.online ? 'Online' : 'Offline'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}
                      <button type="button" className="ghost solar-acc-open" onClick={() => openStation(s)}>Open plant detail →</button>
                    </div>
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
