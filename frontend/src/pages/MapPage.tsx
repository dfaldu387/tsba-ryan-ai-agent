// Fleet map on a real basemap (Leaflet + CARTO/OpenStreetMap tiles): clustered,
// status-coloured pins; click a cluster to zoom into it, a pin to open the plant
// drawer. Plants without platform coordinates are placed from their address
// (geocoded on the server, cached) and marked with how precise that is; admins
// can drag a pin to the right spot and save it.
import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AuthError, setPlantLocation, type SolarStation, type StationStatus } from '../api';
import { useCan } from '../lib/console';
import { useConsole } from '../lib/console';
import { fmtInt, fmtKw, fmtKwp, mask, plural } from '../lib/format';
import { PlantDrawer } from './fleet/PlantsPage';
import { Chip, EmptyState, ErrorState, Icon, ProviderChip, RelTime, SearchInput, Section, Segmented, SkeletonRows, STATION_TONE, StatusDot, StatusPill, usePref } from '../ui';
import './pages.css';

const RANK: Record<StationStatus, number> = { offline: 0, partial: 1, unknown: 2, waiting: 3, online: 4 };
const STATUSES: StationStatus[] = ['online', 'partial', 'offline', 'waiting', 'unknown'];
const AU_BOUNDS = L.latLngBounds([-44, 112], [-10, 154]);
// Keyless basemaps (CARTO now requires an API key).
//  satellite: Esri World Imagery + Esri place/boundary labels — the look of the globe.
//  streets:   standard OpenStreetMap (darkened with a CSS filter in dark mode).
type Basemap = 'satellite' | 'streets';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const ESRI_ATTR = 'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
function basemapLayers(kind: Basemap): L.TileLayer[] {
  if (kind === 'satellite') {
    return [
      L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, { attribution: ESRI_ATTR, maxZoom: 21, maxNativeZoom: 19 }),
      L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 21, maxNativeZoom: 19, pane: 'overlayPane', opacity: 0.9 }),
    ];
  }
  return [L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: OSM_ATTR, maxZoom: 21, maxNativeZoom: 19, className: 'pg-osm' })];
}

const located = (s: SolarStation) => typeof s.lat === 'number' && typeof s.lng === 'number';
/** Street-midpoint or suburb-centre geocodes are approximate; house, platform and manual pins are not. */
const isApprox = (s: SolarStation) => s.locationSource === 'street' || s.locationSource === 'suburb';
const SOURCE_LABEL: Record<NonNullable<SolarStation['locationSource']>, string> = {
  manual: 'Position set by an admin',
  provider: 'Position from the monitoring platform',
  house: 'Placed from the street address (house match)',
  street: 'Approximate — placed on the right street, not the house',
  suburb: 'Approximate — placed at the suburb centre',
};

/** Current effective theme (explicit data-theme, else the OS preference). */
function useDark(): boolean {
  const read = () => {
    const t = document.documentElement.getAttribute('data-theme');
    return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(read());
    mq.addEventListener('change', on);
    return () => { mo.disconnect(); mq.removeEventListener('change', on); };
  }, []);
  return dark;
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function MapPage() {
  const { stations, fleetLoading, fleetError, openGroups, navigate, openPlant, providerName, overview, canSeePii, toast, refreshFleet, refreshing, lastUpdated, onAuthError } = useConsole();
  const can = useCan();
  const canEdit = can('manage_connections');
  const [editing, setEditing] = useState<{ lat: number; lng: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StationStatus | 'all'>('all');
  const [active, setActive] = useState<SolarStation | null>(null);
  const dark = useDark();

  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer[]>([]);
  const [basemap, setBasemap] = usePref<Basemap>('map.basemap', 'satellite');
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  const [zoomTick, setZoomTick] = useState(0);
  const [ready, setReady] = useState(false);
  const hasMap = stations.length > 0;

  const onMap = useMemo(() => stations.filter(located), [stations]);
  const approx = onMap.filter((s) => isApprox(s)).length;
  const streetLevel = onMap.filter((s) => s.locationSource === 'street').length;
  const suburbLevel = onMap.filter((s) => s.locationSource === 'suburb').length;
  const missing = stations.length - onMap.length;
  const pending = overview?.geocodePending ?? 0;
  const filtered = useMemo(() => (status === 'all' ? onMap : onMap.filter((s) => s.status === status)), [onMap, status]);
  const keyOf = (s: SolarStation) => `${s.provider}:${s.id}`;
  const focused = focusKey ? stations.find((s) => keyOf(s) === focusKey) ?? null : null;
  const matches = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return stations.filter((s) => {
      const hay = `${s.name} ${s.id} ${providerName(s.provider)} ${canSeePii ? `${s.location ?? ''} ${s.owner ?? ''}` : ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    }).sort((a, b) => Number(located(b)) - Number(located(a)) || a.name.localeCompare(b.name)).slice(0, 50);
  }, [q, stations, providerName, canSeePii]);
  const issues = filtered.filter((s) => s.status === 'offline' || s.status === 'partial').sort((a, b) => RANK[a.status] - RANK[b.status]).slice(0, 40);

  // ── Create the map once ──
  useEffect(() => {
    if (!host.current || mapRef.current) return;
    const map = L.map(host.current, {
      zoomControl: false, attributionControl: true, minZoom: 3, maxZoom: 21,
      maxBounds: AU_BOUNDS.pad(0.6), worldCopyJump: false,
    }).fitBounds(AU_BOUNDS);
    L.control.zoom({ position: 'topright' }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    map.on('zoomend moveend', () => setZoomTick((t) => t + 1));
    mapRef.current = map;
    setReady(true);
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(host.current);
    return () => { ro.disconnect(); map.remove(); mapRef.current = null; tileRef.current = []; fitted.current = false; setReady(false); };
  }, [hasMap]);

  // ── Basemap (satellite / streets) ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    tileRef.current.forEach((l) => l.remove());
    tileRef.current = basemapLayers(basemap).map((l) => l.addTo(map));
    tileRef.current[0]?.bringToBack();
  }, [basemap, ready]);

  // ── First load: frame the plants ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fitted.current || onMap.length === 0) return;
    map.fitBounds(L.latLngBounds(onMap.map((s) => [s.lat as number, s.lng as number])).pad(0.15), { maxZoom: 10 });
    fitted.current = true;
  }, [onMap, ready]);

  // ── Pins: grid clustering in screen space, recomputed on zoom/pan/filter ──
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const CELL = 46;
    const cells = new Map<string, SolarStation[]>();
    for (const s of filtered) {
      if (focusKey && keyOf(s) === focusKey) continue;
      const p = map.project([s.lat as number, s.lng as number], map.getZoom());
      const k = `${Math.floor(p.x / CELL)}:${Math.floor(p.y / CELL)}`;
      cells.set(k, [...(cells.get(k) ?? []), s]);
    }
    for (const items of cells.values()) {
      const worst = items.reduce((w, s) => (RANK[s.status] < RANK[w] ? s.status : w), items[0].status);
      const tone = STATION_TONE[worst].tone;
      const lat = items.reduce((a, s) => a + (s.lat as number), 0) / items.length;
      const lng = items.reduce((a, s) => a + (s.lng as number), 0) / items.length;
      if (items.length === 1) {
        const s = items[0];
        const m = L.marker([lat, lng], {
          icon: L.divIcon({ className: '', html: `<span class="pg-lpin t-${tone}${isApprox(s) ? ' approx' : ''}"></span>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
          keyboard: true, title: `${s.name} — ${STATION_TONE[s.status].label}${isApprox(s) ? ' (approximate location)' : ''}`,
          riseOnHover: true,
        });
        m.bindTooltip(`<b>${esc(s.name)}</b><br>${STATION_TONE[s.status].label} · ${esc(providerName(s.provider))}<br><i>${esc(SOURCE_LABEL[s.locationSource ?? 'provider'])}</i>`, { direction: 'top', offset: [0, -8] });
        m.on('click', () => setFocusKey(keyOf(s)));
        layer.addLayer(m);
      } else {
        const size = Math.round(30 + Math.min(18, Math.sqrt(items.length) * 3));
        const counts = STATUSES.map((st) => [st, items.filter((s) => s.status === st).length] as const).filter(([, n]) => n > 0);
        const m = L.marker([lat, lng], {
          icon: L.divIcon({
            className: '',
            html: `<span class="pg-lcluster t-${tone}" style="width:${size}px;height:${size}px">${items.length}</span>`,
            iconSize: [size, size], iconAnchor: [size / 2, size / 2],
          }),
          keyboard: true, title: `${items.length} plants`, riseOnHover: true,
        });
        m.bindTooltip(`<b>${items.length} plants</b><br>${counts.map(([st, n]) => `${n} ${STATION_TONE[st].label.toLowerCase()}`).join(' · ')}<br><i>Click to zoom in</i>`, { direction: 'top', offset: [0, -size / 2] });
        m.on('click', () => {
          const b = L.latLngBounds(items.map((s) => [s.lat as number, s.lng as number]));
          if (b.getNorthEast().equals(b.getSouthWest())) map.setView(b.getCenter(), Math.min(20, map.getZoom() + 3));
          else map.fitBounds(b.pad(0.3), { maxZoom: 17 });
        });
        layer.addLayer(m);
      }
    }
    if (focused && located(focused)) {
      const tone = STATION_TONE[focused.status].tone;
      const at = editing ?? { lat: focused.lat as number, lng: focused.lng as number };
      const m = L.marker([at.lat, at.lng], {
        icon: L.divIcon({ className: '', html: `<span class="pg-lfocus t-${tone}${editing ? ' editing' : ''}"><span class="pg-lpin t-${tone}"></span></span>`, iconSize: [44, 44], iconAnchor: [22, 22] }),
        zIndexOffset: 1000, keyboard: true, title: focused.name, draggable: !!editing, autoPan: true,
      });
      m.bindTooltip(editing ? 'Drag me to the right spot' : esc(focused.name), { permanent: true, direction: 'top', offset: [0, -16], className: 'pg-lfocus-label' });
      m.on('dragend', () => { const p = m.getLatLng(); setEditing({ lat: p.lat, lng: p.lng }); });
      if (!editing) m.on('click', () => setActive(focused));
      layer.addLayer(m);
    }
  }, [filtered, zoomTick, providerName, ready, focusKey, focused, editing]);

  // Leaving a plant cancels an unsaved pin move.
  useEffect(() => { setEditing(null); }, [focusKey]);

  const savePin = async (clear = false) => {
    if (!focused) return;
    setSaving(true);
    try {
      await setPlantLocation(focused.provider, focused.id, clear ? null : editing);
      toast({ text: clear ? `${focused.name} is back on its automatic location.` : `Saved the map position for ${focused.name}.`, tone: 'success' });
      setEditing(null);
      await refreshFleet();
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      toast({ text: 'Couldn’t save the position. Try again.', tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  // Select a plant on the map: fly there, highlight its pin and show a summary card.
  // (The drawer only opens from the card or the pin, so it never hides the map.)
  const focus = (s: SolarStation) => {
    setFocusKey(keyOf(s));
    if (status !== 'all' && s.status !== status) setStatus('all');
    if (located(s)) mapRef.current?.flyTo([s.lat as number, s.lng as number], Math.max(mapRef.current.getZoom(), 16), { duration: 0.8 });
  };
  const reset = () => {
    const map = mapRef.current;
    if (!map) return;
    if (onMap.length) map.fitBounds(L.latLngBounds(onMap.map((s) => [s.lat as number, s.lng as number])).pad(0.15), { maxZoom: 10 });
    else map.fitBounds(AU_BOUNDS);
  };

  return (
    <div className="pg-map">
      <Section
        className="pg-map-main"
        title="Fleet map"
        sub={stations.length ? `${fmtInt(onMap.length)} of ${plural(stations.length, 'plant')} on the map` : undefined}
        actions={
          <>
            <div className="c-chips" role="group" aria-label="Status filter">
              <Chip active={status === 'all'} onClick={() => setStatus('all')} count={onMap.length}>All</Chip>
              {STATUSES.filter((st) => onMap.some((s) => s.status === st)).map((st) => (
                <Chip key={st} tone={STATION_TONE[st].tone} active={status === st} onClick={() => setStatus(status === st ? 'all' : st)}
                  count={onMap.filter((s) => s.status === st).length}>{STATION_TONE[st].label}</Chip>
              ))}
            </div>
            <button type="button" className="c-btn sm" onClick={() => void refreshFleet(true)} disabled={refreshing}
              title="Pull fresh data from every monitoring platform now">
              <Icon name="refresh" size={14} /> {refreshing ? 'Refreshing…' : lastUpdated ? <>Updated <RelTime t={lastUpdated} /></> : 'Refresh'}
            </button>
            <button type="button" className="c-btn sm" onClick={() => navigate('energy')} title="Full-screen dark wall display"><Icon name="monitor" size={14} /> Control room</button>
          </>
        }
      >
        {fleetLoading && stations.length === 0 ? <SkeletonRows rows={8} cols={1} /> : stations.length === 0 && fleetError ? (
          <ErrorState title="Monitoring data unavailable" detail={fleetError} onRetry={() => void refreshFleet()} />
        ) : stations.length === 0 ? (
          <EmptyState icon="map" title="No plants yet" hint="Connect a monitoring platform to see plants on the map."
            action={<button type="button" className="c-btn sm" onClick={() => navigate('connections')}>Connections</button>} />
        ) : (
          <div className="pg-map-canvas">
            <div ref={host} className={`pg-leaflet ${dark ? 'is-dark' : ''}`} role="application" aria-label={`Map with ${fmtInt(filtered.length)} plants`} />
            <div className="pg-map-tools">
              <button type="button" className="c-btn sm" onClick={reset} title="Show the whole fleet"><Icon name="refresh" size={14} /> Fit fleet</button>
              <Segmented label="Map style" value={basemap} onChange={setBasemap}
                options={[{ value: 'satellite', label: 'Satellite' }, { value: 'streets', label: 'Streets' }]} />
            </div>
            {focused && (
              <div className="pg-map-card" role="region" aria-label={`Selected plant ${focused.name}`}>
                <div className="pg-map-card-h">
                  <strong className="c-trunc" title={focused.name}>{focused.name}</strong>
                  <button type="button" className="c-iconbtn" onClick={() => setFocusKey(null)} aria-label="Clear selection"><Icon name="x" size={16} /></button>
                </div>
                <div className="pg-map-card-meta">
                  <StatusPill status={focused.status} />
                  <ProviderChip id={focused.provider} name={providerName(focused.provider)} />
                </div>
                {focused.location && <p className="pg-map-card-addr"><Icon name="map" size={14} /> {canSeePii ? focused.location : mask(focused.location)}</p>}
                {!located(focused) ? (
                  <p className="pg-map-card-note">This plant has no location yet, so it isn’t on the map.</p>
                ) : (
                  <p className={`pg-map-card-src ${isApprox(focused) ? 'is-approx' : ''}`}>
                    <Icon name={isApprox(focused) ? 'alert' : 'check'} size={14} /> {SOURCE_LABEL[focused.locationSource ?? 'provider']}
                    {isApprox(focused) && canEdit && !editing && <> — drag it to the exact spot with <b>Adjust pin</b>.</>}
                  </p>
                )}
                <dl className="pg-map-card-kv">
                  <div><dt>Now</dt><dd>{fmtKw(focused.currentPowerW, 1)}</dd></div>
                  <div><dt>Capacity</dt><dd>{fmtKwp(focused.capacityKw)}</dd></div>
                </dl>
                {editing ? (
                  <div className="pg-map-card-a">
                    <button type="button" className="c-btn sm primary" onClick={() => void savePin()} disabled={saving}>{saving ? 'Saving…' : 'Save position'}</button>
                    <button type="button" className="c-btn sm" onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
                  </div>
                ) : (
                  <div className="pg-map-card-a">
                    <button type="button" className="c-btn sm primary" onClick={() => setActive(focused)}>Details</button>
                    <button type="button" className="c-btn sm" onClick={() => openPlant(focused)}>Open plant <Icon name="chevron" size={14} /></button>
                    {canEdit && located(focused) && (
                      <button type="button" className="c-btn sm ghost" onClick={() => {
                        setEditing({ lat: focused.lat as number, lng: focused.lng as number });
                        mapRef.current?.setView([focused.lat as number, focused.lng as number], Math.max(mapRef.current.getZoom(), 19));
                      }} title="Drag the pin to the plant's exact location"><Icon name="map" size={14} /> Adjust pin</button>
                    )}
                    {canEdit && focused.locationSource === 'manual' && (
                      <button type="button" className="c-btn sm ghost" onClick={() => void savePin(true)} disabled={saving}>Reset to automatic</button>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="pg-map-legend" aria-hidden="true">
              {STATUSES.map((s) => <StatusDot key={s} status={s} label />)}
              {approx > 0 && <span className="pg-map-approx"><span className="pg-lpin t-neutral approx" /> Approximate</span>}
            </div>
          </div>
        )}
        {stations.length > 0 && (
          <div className="c-tablefoot">
            <span>
              {approx > 0 && <>{plural(approx, 'pin')} {approx === 1 ? 'is' : 'are'} approximate (dashed outline): {streetLevel > 0 && <>{fmtInt(streetLevel)} on the right street but not the house</>}{streetLevel > 0 && suburbLevel > 0 && ', '}{suburbLevel > 0 && <>{fmtInt(suburbLevel)} at the suburb centre</>}{canEdit ? ' — select one and use Adjust pin to fix it. ' : '. '}</>}
              {missing > 0 && (pending > 0
                ? <>Locating {fmtInt(pending)} more from {pending === 1 ? 'its address' : 'their addresses'} — they’ll appear on the next refresh. </>
                : <>{plural(missing, 'plant')} {missing === 1 ? 'has' : 'have'} no usable address and {missing === 1 ? 'isn’t' : 'aren’t'} shown.</>)}
            </span>
            <button type="button" className="c-link" onClick={() => navigate('solar', '?view=plants')}>See all in Plants →</button>
          </div>
        )}
      </Section>

      <Section className="pg-map-side" title={q.trim() ? 'Search results' : 'Needs attention'}
        sub={q.trim() ? fmtInt(matches.length) : issues.length ? fmtInt(issues.length) : undefined}>
        <div className="pg-map-find">
          <SearchInput value={q} onChange={setQ} label="Find a plant on the map"
            placeholder={canSeePii ? 'Find a plant — name, address, ID…' : 'Find a plant — name or ID…'} />
        </div>
        {q.trim() ? (
          matches.length === 0 ? <EmptyState icon="search" title="No plants match" hint="Try part of the name, suburb or plant ID." /> : (
            <ul className="pg-map-issues">
              {matches.map((s) => (
                <li key={keyOf(s)}>
                  <button type="button" onClick={() => focus(s)} aria-current={focusKey === keyOf(s) ? 'true' : undefined}
                    title={located(s) ? `Show ${s.name} on the map` : `${s.name} has no location yet`}>
                    <StatusDot status={s.status} />
                    <span className="c-grow pg-map-res">
                      <span className="c-trunc">{s.name}</span>
                      <small className="c-trunc">{located(s) ? (s.location ? (canSeePii ? s.location : mask(s.location)) : providerName(s.provider)) : 'Not on map — no location'}</small>
                    </span>
                    {located(s) ? <Icon name="map" size={14} /> : <Icon name="offline" size={14} />}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : issues.length === 0 ? <EmptyState tone="success" icon="check" title="No offline or partial plants on the map" /> : (
          <ul className="pg-map-issues">
            {issues.map((s) => (
              <li key={keyOf(s)}>
                <button type="button" onClick={() => focus(s)} aria-current={focusKey === keyOf(s) ? 'true' : undefined} title={`Show ${s.name} on the map`}>
                  <StatusDot status={s.status} />
                  <span className="c-grow c-trunc" title={s.name}>{s.name}</span>
                  <ProviderChip id={s.provider} name={providerName(s.provider)} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <PlantDrawer station={active} onClose={() => setActive(null)} alerts={active ? openGroups.filter((g) => g.provider === active.provider && g.plantId === active.id) : []}
        perf={null} onOpenFull={(tab) => { if (active) openPlant(active, { tab }); }} />
    </div>
  );
}
