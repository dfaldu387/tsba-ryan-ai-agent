// "Today's work": the five most important things to act on, visible within
// seconds of opening the console. Top KPIs → prioritised queue (alerts + drafts
// mixed) → fleet health + intraday curve → knowledge-base health → About.
import { useEffect, useMemo, useState } from 'react';
import { hasPermission, type AdminOverview, type Draft, type IngestedDocument } from '@tsba/shared';
import {
  AuthError,
  getOverview,
  getSolarFleetHistory,
  listDocuments,
  patchDraft,
  type SolarFleetReading,
} from '../api';
import { useConsole } from '../lib/console';
import { CATEGORY_LABEL, type AlertGroup } from '../lib/alerts';
import { fmtInt, fmtKwh, fmtPowerBig, fmtRel, plural, toMs } from '../lib/format';
import { DayCurve, hourOfDay, localDay, type CurvePoint } from '../ui/charts';
import {
  EmptyState, Icon, KpiTile, Pill, ProviderChip, RelTime, Section, SeverityPill, SkeletonRows, STATION_TONE,
} from '../ui';
import './pages.css';

type QueueItem =
  | { kind: 'alert'; key: string; score: number; group: AlertGroup }
  | { kind: 'draft'; key: string; score: number; draft: Draft };

const STALE_DOC_DAYS = 90;

export function DashboardPage() {
  const {
    user, drafts, openGroups, stations, overview, fleetLoading, alertsLoading, navigate, openPlant,
    providerName, setTriage, upsertDraft, toast, onAuthError,
  } = useConsole();
  const canApprove = hasPermission(user.role, 'approve_drafts');

  const [admin, setAdmin] = useState<AdminOverview | null>(null);
  const [docs, setDocs] = useState<IngestedDocument[] | null>(null);
  const [history, setHistory] = useState<SolarFleetReading[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    const fail = (err: unknown) => { if (err instanceof AuthError) onAuthError(); };
    getOverview().then(setAdmin).catch(fail);
    listDocuments().then((r) => setDocs(r.documents)).catch((e) => { fail(e); setDocs([]); });
    getSolarFleetHistory(48).then((r) => setHistory(r.readings)).catch((e) => { fail(e); setHistory([]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pending = useMemo(() => (drafts ?? []).filter((d) => d.status === 'pending'), [drafts]);
  const critical = openGroups.filter((g) => g.severity === 'critical');
  const warnings = openGroups.filter((g) => g.severity === 'warning');
  const offline = stations.filter((s) => s.status === 'offline');

  // ── Production today vs yesterday at the same time of day ──
  const prod = useMemo(() => {
    const today = stations.reduce((a, s) => a + (s.dailyEnergyKwh ?? 0), 0);
    const powerNow = stations.filter((s) => s.status !== 'offline').reduce((a, s) => a + (s.currentPowerW ?? 0), 0);
    const now = Date.now();
    const todayKey = localDay(now);
    const yKey = localDay(now - 86_400_000);
    const hNow = hourOfDay(now);
    const todayPts: CurvePoint[] = [];
    const yPts: CurvePoint[] = [];
    let yAtNow: number | null = null;
    for (const r of history ?? []) {
      const ms = toMs(r.captured_at);
      if (ms == null) continue;
      const day = localDay(ms);
      const h = hourOfDay(ms);
      const kw = r.total_power_w != null ? r.total_power_w / 1000 : null;
      if (day === todayKey) todayPts.push({ x: h, y: kw });
      else if (day === yKey) {
        yPts.push({ x: h, y: kw });
        if (h <= hNow && r.total_daily_kwh != null) yAtNow = r.total_daily_kwh;
      }
    }
    const deltaPct = yAtNow && yAtNow > 0 ? ((today - yAtNow) / yAtNow) * 100 : null;
    return { today, powerNow, todayPts, yPts, yAtNow, deltaPct };
  }, [stations, history]);

  // ── Prioritised "Needs attention" queue ──
  const queue = useMemo<QueueItem[]>(() => {
    const items: QueueItem[] = [];
    const now = Date.now();
    for (const g of openGroups) {
      if (g.severity === 'info') continue;
      const base = g.severity === 'critical' ? 100 : 50;
      items.push({ kind: 'alert', key: `a:${g.key}`, score: base + Math.min(20, g.count), group: g });
    }
    for (const d of pending) {
      const ageH = (now - (toMs(d.created_at) ?? now)) / 3_600_000;
      const review = d.outcome !== 'answer';
      items.push({ kind: 'draft', key: `d:${d.id}`, score: (review ? 95 : 80) + Math.min(19, ageH), draft: d });
    }
    return items.sort((a, b) => b.score - a.score);
  }, [openGroups, pending]);

  const health = useMemo(() => {
    const order = ['online', 'partial', 'offline', 'waiting', 'unknown'] as const;
    return order.map((st) => ({ st, n: stations.filter((s) => s.status === st).length })).filter((x) => x.n > 0);
  }, [stations]);

  const kb = useMemo(() => {
    if (!docs) return null;
    const now = Date.now();
    const failed = docs.filter((d) => d.status === 'failed').length;
    const corrupted = docs.filter((d) => d.text_quality === 'corrupted' || d.text_quality === 'low').length;
    const stale = docs.filter((d) => d.source === 'google-drive' && now - (toMs(d.ingested_at) ?? now) > STALE_DOC_DAYS * 86_400_000).length;
    const last = docs.reduce<number | null>((m, d) => { const t = toMs(d.ingested_at); return t != null && (m == null || t > m) ? t : m; }, null);
    return { total: docs.length, failed, corrupted, stale, last };
  }, [docs]);

  async function approve(d: Draft) {
    setBusy(d.id);
    try {
      const updated = await patchDraft(d.id, { action: 'approve' });
      upsertDraft(updated);
      toast({ tone: 'success', text: updated.status === 'team' ? 'Reply sent; question handed to the team' : 'Reply approved and sent' });
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      toast({ tone: 'danger', text: 'Approval didn’t go through. Try again.' });
    } finally {
      setBusy(null);
    }
  }

  function ack(g: AlertGroup) {
    setTriage(g.key, { ack: Date.now() });
    toast({ text: `Acknowledged: ${g.fault} at ${g.plant}`, action: { label: 'Undo', run: () => setTriage(g.key, { ack: undefined }) } });
  }

  const shown = queue.slice(0, 8);
  const greeting = (() => {
    const h = hourOfDay(Date.now());
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  })();

  // Open alert issues per monitoring platform (critical vs other), largest first.
  const byProvider = (() => {
    const m = new Map<string, { provider: string; total: number; critical: number }>();
    for (const g of openGroups) {
      const r = m.get(g.provider) ?? { provider: g.provider, total: 0, critical: 0 };
      r.total += 1;
      if (g.severity === 'critical') r.critical += 1;
      m.set(g.provider, r);
    }
    return [...m.values()].sort((a, b) => b.critical - a.critical || b.total - a.total);
  })();
  const byProviderMax = Math.max(1, ...byProvider.map((r) => r.total));

  return (
    <div className="pg-dash">
      <div className="pg-hello">
        <h2>{greeting}{user.name ? `, ${user.name.split(' ')[0]}` : ''}</h2>
        <p>
          {queue.length === 0
            ? 'Nothing needs you right now.'
            : `${plural(queue.length, 'item')} need attention — the most urgent are at the top.`}
        </p>
      </div>

      {/* ── KPI row ── */}
      <div className="c-kpis">
        <KpiTile
          label="Drafts awaiting approval" icon="drafts" tone={pending.length ? 'brand' : undefined}
          loading={drafts == null}
          value={fmtInt(pending.length)}
          sub={pending.length ? `oldest ${fmtRel(Math.min(...pending.map((d) => toMs(d.created_at) ?? Date.now())))}` : 'Queue is clear'}
          onClick={() => navigate('drafts')}
        />
        <KpiTile
          label="Critical alerts" icon="alert" tone={critical.length ? 'danger' : 'success'}
          loading={alertsLoading}
          value={fmtInt(critical.length)}
          sub={`${fmtInt(warnings.length)} warnings · grouped by plant`}
          onClick={() => navigate('solar', '?view=alerts&sev=critical')}
        />
        <KpiTile
          label="Plants offline" icon="offline" tone={offline.length ? 'danger' : 'success'}
          loading={fleetLoading}
          value={<>{fmtInt(offline.length)}<small>/ {fmtInt(stations.length)}</small></>}
          sub={overview?.errors.length ? `${overview.errors.length} provider${overview.errors.length === 1 ? '' : 's'} unreachable` : 'All providers reachable'}
          onClick={() => navigate('solar', '?view=plants&status=offline')}
        />
        <KpiTile
          label="Production today" icon="sun" tone="info"
          loading={fleetLoading}
          value={fmtKwh(prod.today)}
          delta={prod.deltaPct != null ? { text: `${prod.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(prod.deltaPct))}%`, tone: prod.deltaPct >= -10 ? 'success' : 'warning' } : undefined}
          sub={prod.yAtNow != null ? `vs ${fmtKwh(prod.yAtNow)} yesterday at this time` : `Now ${fmtPowerBig(prod.powerNow)}`}
          spark={prod.todayPts.map((p) => p.y)}
          onClick={() => navigate('solar', '?view=analytics')}
        />
      </div>

      <div className="pg-dash-grid">
        <div className="pg-dash-col">
        {/* ── Needs attention ── */}
        <Section
          className="pg-queue"
          title="Needs attention"
          sub={queue.length ? `${fmtInt(queue.length)} open` : undefined}
          actions={queue.length > shown.length ? (
            <div className="c-row">
              <button type="button" className="c-btn sm" onClick={() => navigate('solar', '?view=alerts')}>All alerts</button>
              <button type="button" className="c-btn sm" onClick={() => navigate('drafts')}>All drafts</button>
            </div>
          ) : undefined}
        >
          {(drafts == null || alertsLoading) && queue.length === 0 ? (
            <SkeletonRows rows={5} cols={3} />
          ) : shown.length === 0 ? (
            <EmptyState tone="success" icon="check" title="All clear" hint="No critical alerts and no drafts waiting for approval." />
          ) : (
            <ol className="pg-queue-list" aria-live="polite">
              {shown.map((it) =>
                it.kind === 'alert' ? (
                  <li key={it.key} className="pg-qi">
                    <span className={`pg-qi-ico t-${it.group.severity === 'critical' ? 'danger' : 'warning'}`}><Icon name="alert" size={16} /></span>
                    <button type="button" className="pg-qi-main" onClick={() => navigate('solar', `?view=alerts&open=${encodeURIComponent(it.group.key)}`)}>
                      <strong>{it.group.fault}{it.group.count > 1 && <span className="pg-qi-count">×{fmtInt(it.group.count)}</span>}</strong>
                      <span className="pg-qi-meta">
                        <span className="c-trunc">{it.group.plant}</span>
                        <ProviderChip id={it.group.provider} name={providerName(it.group.provider)} />
                        <span>{CATEGORY_LABEL[it.group.category]}</span>
                        {it.group.lastSeen && <RelTime t={it.group.lastSeen} />}
                      </span>
                    </button>
                    <SeverityPill severity={it.group.severity} />
                    <div className="pg-qi-act">
                      <button type="button" className="c-btn sm" onClick={() => ack(it.group)}>Acknowledge</button>
                      <button type="button" className="c-btn sm ghost" onClick={() => openPlant({ provider: it.group.provider, id: it.group.plantId })}>Open plant</button>
                    </div>
                  </li>
                ) : (
                  <li key={it.key} className="pg-qi">
                    <span className="pg-qi-ico t-brand"><Icon name="drafts" size={16} /></span>
                    <button type="button" className="pg-qi-main" onClick={() => navigate('drafts', `?draft=${it.draft.id}`)}>
                      <strong className="c-trunc">{it.draft.question}</strong>
                      <span className="pg-qi-meta">
                        <span>Draft reply · {it.draft.audience}</span>
                        <RelTime t={it.draft.created_at} />
                      </span>
                    </button>
                    {it.draft.outcome === 'answer'
                      ? <Pill tone="brand">Ready to approve</Pill>
                      : <Pill tone="warning" dot>Human review</Pill>}
                    <div className="pg-qi-act">
                      {canApprove && it.draft.outcome === 'answer' && (
                        <button type="button" className="c-btn sm primary" disabled={busy === it.draft.id} onClick={() => void approve(it.draft)}>
                          {busy === it.draft.id ? 'Sending…' : 'Approve & send'}
                        </button>
                      )}
                      <button type="button" className="c-btn sm ghost" onClick={() => navigate('drafts', `?draft=${it.draft.id}`)}>Review</button>
                    </div>
                  </li>
                ),
              )}
            </ol>
          )}
        </Section>

        {/* ── Intraday curve ── */}
        <Section className="pg-curve" title="Fleet power today" sub="15-min snapshots · plant-local time">
          <div className="c-pad">
            {history == null ? <span className="c-skel" style={{ height: 200 }} /> : (
              <DayCurve
                label="Fleet power output today compared with yesterday"
                unit="kW"
                valueFmt={(v) => `${v >= 1000 ? `${(v / 1000).toLocaleString('en-AU', { maximumFractionDigits: 2 })} MW` : `${Math.round(v).toLocaleString('en-AU')} kW`}`}
                series={[
                  { name: 'Yesterday', points: prod.yPts, tone: 'neutral', dashed: true },
                  { name: 'Today', points: prod.todayPts, tone: 'brand' },
                ]}
              />
            )}
          </div>
        </Section>

        </div>

        <div className="pg-dash-col">
        {/* ── Fleet health ── */}
        <Section title="Fleet health" sub={stations.length ? `${fmtInt(stations.length)} plants` : undefined}
          actions={<button type="button" className="c-btn sm ghost" onClick={() => navigate('map')}><Icon name="map" size={16} /> Map</button>}>
          <div className="c-pad">
            {fleetLoading ? <span className="c-skel" /> : stations.length === 0 ? (
              <EmptyState icon="plant" title="No plants connected" hint="Connect a monitoring platform to start." action={<button type="button" className="c-btn primary sm" onClick={() => navigate('connections')}>Open connections</button>} />
            ) : (
              <>
                <div className="c-health" role="img" aria-label={health.map((h) => `${h.n} ${STATION_TONE[h.st].label}`).join(', ')}>
                  {health.map((h) => <span key={h.st} className={`t-${STATION_TONE[h.st].tone}`} style={{ flex: h.n }} />)}
                </div>
                <div className="c-health-legend">
                  {health.map((h) => (
                    <button key={h.st} type="button" className={`t-${STATION_TONE[h.st].tone}`} onClick={() => navigate('solar', `?view=plants&status=${h.st}`)}>
                      <span className="c-dot" /> <b>{fmtInt(h.n)}</b> {STATION_TONE[h.st].label}
                    </button>
                  ))}
                </div>
                <div className="pg-dash-power">
                  <div><span>Generating now</span><b>{fmtPowerBig(prod.powerNow)}</b></div>
                  <div><span>Capacity</span><b>{fmtInt(stations.reduce((a, s) => a + (s.capacityKw ?? 0), 0))} kWp</b></div>
                </div>
              </>
            )}
          </div>
        </Section>

        {/* ── Open issues by platform ── */}
        <Section title="Open issues by platform" sub={openGroups.length ? `${fmtInt(openGroups.length)} open` : undefined}
          actions={<button type="button" className="c-btn sm ghost" onClick={() => navigate('solar', '?view=alerts')}>Alerts</button>}>
          {byProvider.length === 0 ? <EmptyState tone="success" icon="check" title="No open issues" /> : (
            <ul className="pg-byprov">
              {byProvider.map((r) => (
                <li key={r.provider}>
                  <button type="button" onClick={() => navigate('solar', `?view=alerts&provider=${encodeURIComponent(r.provider)}`)}
                    title={`Show ${providerName(r.provider)} alerts`}>
                    <span className="pg-byprov-name">{providerName(r.provider)}</span>
                    <span className="pg-byprov-bar" aria-hidden="true">
                      <span className="t-danger" style={{ width: `${(r.critical / byProviderMax) * 100}%` }} />
                      <span className="t-warning" style={{ width: `${((r.total - r.critical) / byProviderMax) * 100}%` }} />
                    </span>
                    <span className="pg-byprov-n">
                      <b>{fmtInt(r.total)}</b>
                      {r.critical > 0 && <small className="pg-byprov-crit">{fmtInt(r.critical)} critical</small>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* ── KB health ── */}
        <Section title="Knowledge base health" actions={<button type="button" className="c-btn sm ghost" onClick={() => navigate('knowledge')}>Open</button>}>
          <div className="c-pad pg-kb">
            {!kb ? <SkeletonRows rows={3} cols={2} /> : (
              <>
                <div className="pg-kb-row"><span>Documents</span><b>{fmtInt(kb.total)}</b></div>
                <button type="button" className="pg-kb-row" onClick={() => navigate('knowledge', '?status=flagged')}>
                  <span>Unreadable text (needs OCR)</span>
                  {kb.corrupted ? <Pill tone="warning" dot>{fmtInt(kb.corrupted)}</Pill> : <Pill tone="success">0</Pill>}
                </button>
                <button type="button" className="pg-kb-row" onClick={() => navigate('knowledge', '?status=failed')}>
                  <span>Failed ingests</span>
                  {kb.failed ? <Pill tone="danger" dot>{fmtInt(kb.failed)}</Pill> : <Pill tone="success">0</Pill>}
                </button>
                <div className="pg-kb-row">
                  <span>Stale (&gt; {STALE_DOC_DAYS} days)</span>
                  {kb.stale ? <Pill tone="neutral">{fmtInt(kb.stale)}</Pill> : <Pill tone="success">0</Pill>}
                </div>
                <div className="pg-kb-row"><span>Last ingest</span><RelTime t={kb.last} /></div>
              </>
            )}
          </div>
        </Section>
        </div>
      </div>

      {/* ── About the agent (collapsed) ── */}
      <details className="pg-about">
        <summary>
          <Icon name="ai" size={16} />
          <span>About the agent</span>
          {admin?.system && (
            <Pill tone={admin.system.anthropic ? 'success' : 'warning'} dot>
              {admin.system.anthropic ? `Drafting live · ${admin.system.model}` : 'Offline fallback'}
            </Pill>
          )}
          <Icon name="chevronDown" size={16} className="pg-about-caret" />
        </summary>
        {admin?.agent && (
          <div className="pg-about-body">
            <p className="pg-about-tag">{admin.agent.tagline}</p>
            <div className="pg-about-cols">
              <div>
                <h3 className="c-h3">What it can do</h3>
                <ul>{admin.agent.capabilities.map((c) => <li key={c}>{c}</li>)}</ul>
              </div>
              <div>
                <h3 className="c-h3">Guardrails (always on)</h3>
                <ul>{admin.agent.guardrails.map((c) => <li key={c}>{c}</li>)}</ul>
              </div>
              <div>
                <h3 className="c-h3">System</h3>
                <dl className="c-dl">
                  <div><dt>Embeddings</dt><dd>{admin.system.embeddingProvider}</dd></div>
                  <div><dt>Storage</dt><dd>{admin.system.usesPostgres ? 'PostgreSQL' : 'In-memory'}</dd></div>
                  <div><dt>Knowledge chunks</dt><dd>{fmtInt(admin.knowledge.chunks)}</dd></div>
                  <div><dt>Drafts all-time</dt><dd>{fmtInt(admin.drafts.total)}</dd></div>
                </dl>
              </div>
            </div>
          </div>
        )}
      </details>
    </div>
  );
}
