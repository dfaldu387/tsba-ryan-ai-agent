// Monitoring-platform integrations, sorted by health (problems first). Sync
// time = the newest data timestamp that provider actually returned (not page
// load time). Statuses: Connected · Degraded · Auth expired · No plants ·
// Not configured.
import { useMemo, useState } from 'react';
import { hasPermission } from '@tsba/shared';
import type { SolarProviderInfo } from '../api';
import { useConsole } from '../lib/console';
import { fmtInt, plural, toMs } from '../lib/format';
import { Drawer, EmptyState, Icon, Pill, RelTime, Section, SkeletonRows, providerHue, type Tone } from '../ui';
import './pages.css';

type Health = 'auth' | 'error' | 'degraded' | 'none' | 'ok' | 'off';
const META: Record<Health, { label: string; tone: Tone; rank: number }> = {
  auth: { label: 'Auth expired', tone: 'danger', rank: 0 },
  error: { label: 'Unreachable', tone: 'danger', rank: 1 },
  degraded: { label: 'Degraded', tone: 'warning', rank: 2 },
  none: { label: 'No plants', tone: 'neutral', rank: 3 },
  ok: { label: 'Connected', tone: 'success', rank: 4 },
  off: { label: 'Not configured', tone: 'neutral', rank: 5 },
};
const AUTH_RX = /auth|401|403|token|login|password|credential|unauthori|session|expired|captcha|turnstile/i;

/** What an administrator needs to supply for each platform (no dev jargon). */
const NEEDS: Record<string, string[]> = {
  deye: ['Deye Cloud developer App ID & secret', 'Account email & password', 'Data centre region (EU / US / AMEA)'],
  goodwe: ['SEMS portal email & password', 'Region (AU / EU / US)'],
  sigen: ['SigenCloud OpenAPI account', 'Region (Australia)'],
  solis: ['SolisCloud API key & secret'],
};

export function IntegrationsPanel() {
  const { providers, stations, overview, refreshFleet, refreshing, navigate, user, fleetLoading } = useConsole();
  const [configure, setConfigure] = useState<SolarProviderInfo | null>(null);
  const isAdmin = hasPermission(user.role, 'manage_connections');

  const rows = useMemo(() => {
    const now = Date.now();
    return (providers ?? []).map((p) => {
      const plants = stations.filter((s) => s.provider === p.id);
      const offline = plants.filter((s) => s.status === 'offline').length;
      const synced = plants.reduce<number | null>((m, s) => { const t = toMs(s.lastUpdate); return t != null && (m == null || t > m) ? t : m; }, null);
      const err = overview?.errors.find((e) => e.provider === p.id)?.error;
      const unavailable = overview?.unavailable?.includes(p.id);
      let h: Health;
      const reasons: string[] = [];
      if (!p.configured) h = 'off';
      else if (err && AUTH_RX.test(err)) { h = 'auth'; reasons.push(err); }
      else if (err) { h = 'error'; reasons.push(err); }
      else if (unavailable) { h = 'auth'; reasons.push('The portal session returned no data — it likely needs to be signed in again.'); }
      else if (plants.length === 0) h = 'none';
      else {
        h = 'ok';
        if (plants.length >= 4 && offline / plants.length > 0.5) reasons.push(`${fmtInt(offline)} of ${fmtInt(plants.length)} plants offline`);
        if (synced != null && now - synced > 3 * 3_600_000) reasons.push('Newest data is more than 3 hours old');
        if (reasons.length) h = 'degraded';
      }
      return { p, h, plants: plants.length, offline, synced, reasons };
    }).sort((a, b) => META[a.h].rank - META[b.h].rank || b.plants - a.plants || a.p.name.localeCompare(b.p.name));
  }, [providers, stations, overview]);

  const problems = rows.filter((r) => META[r.h].rank <= 2).length;
  const connected = rows.filter((r) => r.h !== 'off').length;

  return (
    <Section
      title="Monitoring platforms"
      sub={providers ? `${connected} of ${rows.length} connected${problems ? ` · ${plural(problems, 'needs', 'need')} attention` : ''}` : undefined}
      actions={<button type="button" className="c-btn sm" onClick={() => void refreshFleet()} disabled={refreshing}><Icon name="refresh" size={14} /> {refreshing ? 'Checking…' : 'Check all now'}</button>}
    >
      {fleetLoading && !providers ? <SkeletonRows rows={3} cols={4} /> : rows.length === 0 ? (
        <EmptyState icon="link" title="No monitoring platforms available" />
      ) : (
        <div className="pg-integ">
          {rows.map(({ p, h, plants, offline, synced, reasons }) => (
            <article key={p.id} className={`pg-integ-card h-${h}`} style={{ ['--h' as string]: providerHue(p.id) }}>
              <header>
                <span className="pg-integ-logo" aria-hidden="true">{p.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()}</span>
                <div className="c-grow">
                  <strong>{p.name}</strong>
                  <Pill tone={META[h].tone} dot>{META[h].label}</Pill>
                </div>
              </header>
              <dl className="pg-integ-meta">
                <div><dt>Plants</dt><dd>{p.configured ? fmtInt(plants) : '—'}{offline > 0 && <span className="c-muted"> · {fmtInt(offline)} offline</span>}</dd></div>
                <div><dt>Last data</dt><dd>{p.configured ? <RelTime t={synced} stale /> : '—'}</dd></div>
              </dl>
              {reasons.length > 0 && (
                <details className="pg-integ-err" open={h === 'auth' || h === 'error'}>
                  <summary>{h === 'degraded' ? 'Why degraded' : 'Error details'}</summary>
                  <ul>{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                </details>
              )}
              <footer>
                {h === 'auth' && <button type="button" className="c-btn sm primary" onClick={() => setConfigure(p)}>Re-authenticate</button>}
                {h === 'error' && <button type="button" className="c-btn sm primary" onClick={() => void refreshFleet()} disabled={refreshing}>Retry now</button>}
                {h === 'off' && <button type="button" className="c-btn sm" onClick={() => setConfigure(p)}>Configure</button>}
                {plants > 0 && <button type="button" className="c-btn sm ghost" onClick={() => navigate('solar', `?view=plants&provider=${p.id}`)}>View plants</button>}
              </footer>
            </article>
          ))}
        </div>
      )}

      <Drawer open={configure != null} onClose={() => setConfigure(null)} title={configure ? `${configure.name} connection` : ''}
        sub={configure ? <Pill tone={configure.configured ? 'danger' : 'neutral'}>{configure.configured ? 'Sign-in needs renewing' : 'Not configured'}</Pill> : undefined}
        footer={<>
          <button type="button" className="c-btn primary" onClick={() => { void refreshFleet(); setConfigure(null); }}>Test connection</button>
          <button type="button" className="c-btn ghost" onClick={() => setConfigure(null)}>Close</button>
        </>}>
        {configure && (
          <>
            <p>
              {configure.configured
                ? `TSBA’s ${configure.name} sign-in was rejected or has expired. Once the account details are updated, use “Test connection” to confirm the plants come back.`
                : `${configure.name} isn’t connected yet. Connecting it brings its plants and alerts into the fleet view.`}
            </p>
            <div>
              <h3 className="c-h3">What’s needed</h3>
              <ul className="pg-needs">
                {(NEEDS[Object.keys(NEEDS).find((k) => configure.id.toLowerCase().includes(k)) ?? ''] ?? ['Portal account email & password for the TSBA installer account']).map((n) => <li key={n}><Icon name="check" size={14} /> {n}</li>)}
              </ul>
            </div>
            <div className="c-banner t-info"><Icon name="shield" size={16} /><span>
              {isAdmin
                ? 'Platform credentials are kept on the TSBA server and are never sent to the browser. Update them in the server configuration, then test the connection here.'
                : 'Only an administrator can update platform credentials. Ask an admin to renew this connection.'}
            </span></div>
          </>
        )}
      </Drawer>
    </Section>
  );
}
