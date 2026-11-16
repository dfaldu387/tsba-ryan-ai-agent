// Alert triage. Raw provider alerts are grouped by plant + fault (count, first
// and last seen); severity is separate from category. Row actions: acknowledge,
// assign, snooze, open plant, draft customer email, ask AI how to fix. Bulk
// toolbar, saved views and an expandable timeline per group.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { hasPermission, type Draft, type IngestedDocument, type PlantContacts } from '@tsba/shared';
import { AuthError, createDraft, getPlantContacts, listDocuments } from '../../api';
import { useConsole } from '../../lib/console';
import {
  CATEGORIES, CATEGORY_LABEL, isSnoozed, SEVERITY_LABEL, type AlertGroup, type Category, type Severity,
} from '../../lib/alerts';
import { brandTokens, customerEmailQuestion, fixQuestion, matchDocs } from '../../lib/aiActions';
import { fmtAbs, fmtInt, plural } from '../../lib/format';
import {
  EmptyState, ErrorState, Icon, Menu, Pill, ProviderChip, RelTime, SearchInput, SeverityPill, SkeletonRows, usePref, usePaged, Pager,
} from '../../ui';

type ViewKey = 'open' | 'critical' | 'offline' | 'mine' | 'ack' | 'snoozed' | 'all';
const VIEWS: { key: ViewKey; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'critical', label: 'Critical' },
  { key: 'offline', label: 'Offline plants' },
  { key: 'mine', label: 'Assigned to me' },
  { key: 'ack', label: 'Acknowledged' },
  { key: 'snoozed', label: 'Snoozed' },
  { key: 'all', label: 'All' },
];
interface SavedView { name: string; view: ViewKey; sev: Severity | 'all'; cat: Category | 'all'; provider: string; q: string }

export function AlertsPage({ search }: { search: string }) {
  const {
    user, groups, alerts, alertsLoading, providers, providerName, triage, setTriage, openPlant, toast, navigate,
    upsertDraft, onAuthError, refreshFleet,
  } = useConsole();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const me = user.name || user.email;
  const canAsk = hasPermission(user.role, 'ask');

  const [view, setView] = useState<ViewKey>('open');
  const [sev, setSev] = useState<Severity | 'all'>((params.get('sev') as Severity) || 'all');
  const [cat, setCat] = useState<Category | 'all'>((params.get('cat') as Category) || 'all');
  const [provider, setProvider] = useState(params.get('provider') || 'all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(params.get('open'));
  const [saved, setSaved] = usePref<SavedView[]>('alerts.views', []);
  const [docs, setDocs] = useState<IngestedDocument[] | null>(null);
  const [contacts, setContacts] = useState<PlantContacts | null>(null);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiAnswers, setAiAnswers] = useState<Record<string, Draft>>({});

  useEffect(() => {
    const s = params.get('sev');
    if (s) setSev(s as Severity);
    const o = params.get('open');
    if (o) setExpanded(o);
    const pv = params.get('provider');
    if (pv) setProvider(pv);
    const c = params.get('cat');
    if (c) setCat(c as Category);
  }, [params]);

  // Lazy-load KB docs + plant contacts the first time a group is expanded.
  useEffect(() => {
    if (!expanded) return;
    if (docs == null) listDocuments().then((r) => setDocs(r.documents)).catch(() => setDocs([]));
    if (contacts == null) getPlantContacts().then((r) => setContacts(r.contacts)).catch(() => setContacts({}));
  }, [expanded, docs, contacts]);

  const now = Date.now();
  const stateOf = (g: AlertGroup) => {
    const t = triage[g.key];
    if (isSnoozed(t, now)) return 'snoozed';
    if (t?.ack) return 'ack';
    return 'open';
  };

  const inView = (g: AlertGroup, v: ViewKey) => {
    const st = stateOf(g);
    switch (v) {
      case 'open': return st === 'open';
      case 'critical': return st === 'open' && g.severity === 'critical';
      case 'offline': return st === 'open' && g.category === 'offline';
      case 'mine': return triage[g.key]?.assignee === me;
      case 'ack': return st === 'ack';
      case 'snoozed': return st === 'snoozed';
      default: return true;
    }
  };

  const viewCounts = useMemo(() => {
    const c = {} as Record<ViewKey, number>;
    for (const v of VIEWS) c[v.key] = groups.filter((g) => inView(g, v.key)).length;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, triage]);

  const base = useMemo(() => groups.filter((g) => inView(g, view)), [groups, triage, view]); // eslint-disable-line react-hooks/exhaustive-deps
  const sevCounts = useMemo(() => {
    const c: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
    for (const g of base) c[g.severity] += 1;
    return c;
  }, [base]);

  const shown = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return base.filter((g) => {
      if (sev !== 'all' && g.severity !== sev) return false;
      if (cat !== 'all' && g.category !== cat) return false;
      if (provider !== 'all' && g.provider !== provider) return false;
      if (terms.length) {
        const hay = `${g.plant} ${g.fault} ${g.code ?? ''} ${g.devices.join(' ')} ${providerName(g.provider)}`.toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      return true;
    });
  }, [base, sev, cat, provider, q, providerName]);

  useEffect(() => { setSelected(new Set()); }, [view, sev, cat, provider, q]);
  const paged = usePaged(shown, [view, sev, cat, provider, q]);
  const visible = paged.slice;
  const rawCount = alerts?.alerts.length ?? 0;
  const configured = (providers ?? []).filter((p) => p.configured);

  // ── Actions ──
  const ack = (keys: string[]) => {
    keys.forEach((k) => setTriage(k, { ack: Date.now(), snoozeUntil: undefined }));
    toast({ text: `Acknowledged ${plural(keys.length, 'alert group')}`, action: { label: 'Undo', run: () => keys.forEach((k) => setTriage(k, { ack: undefined })) } });
    setSelected(new Set());
  };
  const reopen = (keys: string[]) => {
    keys.forEach((k) => setTriage(k, { ack: undefined, snoozeUntil: undefined }));
    toast({ text: `Reopened ${plural(keys.length, 'alert group')}` });
  };
  const assign = (keys: string[], who: string | undefined) => {
    keys.forEach((k) => setTriage(k, { assignee: who }));
    toast({ text: who ? `Assigned ${plural(keys.length, 'group')} to ${who === me ? 'you' : who}` : 'Unassigned' });
    setSelected(new Set());
  };
  const snooze = (keys: string[], hours: number) => {
    keys.forEach((k) => setTriage(k, { snoozeUntil: Date.now() + hours * 3_600_000 }));
    toast({ text: `Snoozed ${plural(keys.length, 'group')} for ${hours} h`, action: { label: 'Undo', run: () => keys.forEach((k) => setTriage(k, { snoozeUntil: undefined })) } });
    setSelected(new Set());
  };

  async function aiDraft(g: AlertGroup, kind: 'fix' | 'email') {
    setAiBusy(`${kind}:${g.key}`);
    try {
      const contact = contacts?.[`${g.provider}:${g.plantId}`];
      const draft = await createDraft(
        kind === 'fix'
          ? { question: fixQuestion(g, providerName(g.provider)), audience: 'installer', channel: 'chat' }
          : { question: customerEmailQuestion(g, providerName(g.provider)), audience: 'customer', channel: 'email', recipient: contact?.email ?? null },
      );
      upsertDraft(draft);
      if (kind === 'fix') {
        setAiAnswers((a) => ({ ...a, [g.key]: draft }));
        setExpanded(g.key);
      }
      toast({
        tone: 'success',
        text: kind === 'fix' ? 'AI answer ready — also saved to Drafts' : 'Customer email drafted — waiting for approval',
        action: { label: 'Open draft', run: () => navigate('drafts', `?draft=${draft.id}`) },
      });
    } catch (err) {
      if (err instanceof AuthError) return onAuthError();
      toast({ tone: 'danger', text: 'The AI couldn’t draft that. Try again.' });
    } finally {
      setAiBusy(null);
    }
  }

  const saveView = () => {
    const name = window.prompt('Name this view', `${VIEWS.find((v) => v.key === view)?.label}${sev !== 'all' ? ` · ${SEVERITY_LABEL[sev]}` : ''}`);
    if (!name) return;
    setSaved([...saved.filter((s) => s.name !== name), { name, view, sev, cat, provider, q }]);
    toast({ tone: 'success', text: `Saved view “${name}”` });
  };
  const applyView = (s: SavedView) => { setView(s.view); setSev(s.sev); setCat(s.cat); setProvider(s.provider); setQ(s.q); };

  const toggle = (k: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const allSel = visible.length > 0 && visible.every((g) => selected.has(g.key));
  const selKeys = [...selected];

  const rowMenu = (g: AlertGroup) => {
    const st = stateOf(g);
    const items: Parameters<typeof Menu>[0]['items'] = [
      st === 'open'
        ? { label: 'Acknowledge', icon: 'check', onSelect: () => ack([g.key]) }
        : { label: 'Reopen', icon: 'refresh', onSelect: () => reopen([g.key]) },
      triage[g.key]?.assignee === me
        ? { label: 'Unassign', icon: 'user', onSelect: () => assign([g.key], undefined) }
        : { label: 'Assign to me', icon: 'user', onSelect: () => assign([g.key], me) },
      { label: 'Snooze 4 hours', icon: 'clock', onSelect: () => snooze([g.key], 4) },
      { label: 'Snooze 24 hours', icon: 'clock', onSelect: () => snooze([g.key], 24) },
      'sep',
      { label: 'Open plant', icon: 'plant', onSelect: () => openPlant({ provider: g.provider, id: g.plantId }) },
    ];
    if (canAsk) {
      items.push(
        { label: 'Draft customer email', icon: 'mail', onSelect: () => void aiDraft(g, 'email') },
        { label: 'Ask AI how to fix', icon: 'ai', onSelect: () => void aiDraft(g, 'fix') },
      );
    }
    return items;
  };

  // Until the first scan lands, counts are unknown, not zero.
  const counting = !alerts && alertsLoading;
  const n = (v: number | undefined) => (counting ? '–' : fmtInt(v ?? 0));

  return (
    <div className="pg-alerts" aria-busy={counting}>
      {alerts?.errors?.map((e) => (
        <div key={e.provider} className="c-banner t-warning"><Icon name="alert" /> <span><b>{e.name}</b> couldn’t be scanned: {e.error}</span></div>
      ))}

      {/* ── Summary strip ── */}
      <div className="pg-sumstrip" role="group" aria-label="Alert summary">
        {(['critical', 'warning', 'info'] as Severity[]).map((s) => (
          <button key={s} type="button" className={`pg-sum t-${s === 'critical' ? 'danger' : s === 'warning' ? 'warning' : 'info'} ${sev === s ? 'on' : ''}`}
            aria-pressed={sev === s} onClick={() => setSev(sev === s ? 'all' : s)}>
            <span className="c-dot" />
            <b>{n(sevCounts[s])}</b>
            <span>{SEVERITY_LABEL[s]}</span>
          </button>
        ))}
        <div className="pg-sum-meta">
          {alerts ? (
            <>
              <b>{fmtInt(rawCount)}</b> raw alerts grouped into <b>{fmtInt(groups.length)}</b> issues
              <span className="c-muted"> · scanned {fmtInt(alerts.scannedPlants)} plants <RelTime t={alerts.generatedAt} /></span>
            </>
          ) : alertsLoading ? 'Scanning the fleet…' : null}
          <button type="button" className="c-iconbtn" onClick={() => void refreshFleet()} aria-label="Refresh alerts" title="Refresh"><Icon name="refresh" size={16} /></button>
        </div>
      </div>

      <section className="c-section">
        {/* ── Saved views ── */}
        <div className="pg-views" role="tablist" aria-label="Alert views">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" role="tab" aria-selected={view === v.key} onClick={() => setView(v.key)}>
              {v.label}<span className="c-tab-n">{n(viewCounts[v.key])}</span>
            </button>
          ))}
          {saved.map((s) => (
            <span key={s.name} className="pg-saved">
              <button type="button" onClick={() => applyView(s)}><Icon name="sliders" size={14} />{s.name}</button>
              <button type="button" className="pg-saved-x" aria-label={`Delete view ${s.name}`} onClick={() => setSaved(saved.filter((x) => x.name !== s.name))}><Icon name="x" size={12} /></button>
            </span>
          ))}
        </div>

        {/* ── Filters ── */}
        <div className="c-toolbar">
          <SearchInput value={q} onChange={setQ} label="Search alerts" placeholder="Plant, fault, code or serial…" />
          <select className="c-select" value={cat} onChange={(e) => setCat(e.target.value as Category | 'all')} aria-label="Category">
            <option value="all">All categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
          {configured.length > 1 && (
            <select className="c-select" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
              <option value="all">All providers</option>
              {configured.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <span className="c-spacer" />
          <button type="button" className="c-btn sm ghost" onClick={saveView}><Icon name="plus" size={14} /> Save view</button>
        </div>

        {/* ── Bulk toolbar ── */}
        {selKeys.length > 0 && (
          <div className="c-bulk" role="region" aria-label="Bulk actions">
            <span>{plural(selKeys.length, 'group')} selected</span>
            <button type="button" className="c-btn sm" onClick={() => ack(selKeys)}><Icon name="check" size={14} /> Acknowledge</button>
            <button type="button" className="c-btn sm" onClick={() => assign(selKeys, me)}><Icon name="user" size={14} /> Assign to me</button>
            <button type="button" className="c-btn sm" onClick={() => snooze(selKeys, 4)}><Icon name="clock" size={14} /> Snooze 4 h</button>
            <button type="button" className="c-btn sm ghost" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}

        {alertsLoading && !alerts ? (
          <SkeletonRows rows={8} cols={6} />
        ) : !alerts ? (
          <div className="c-pad"><ErrorState title="Alerts couldn’t be loaded" onRetry={() => void refreshFleet()} /></div>
        ) : shown.length === 0 ? (
          <EmptyState
            tone={groups.length === 0 ? 'success' : 'neutral'}
            icon={groups.length === 0 ? 'check' : 'search'}
            title={groups.length === 0 ? 'No active alerts — the fleet is healthy' : 'Nothing matches this view'}
            hint={groups.length === 0 ? undefined : 'Try another view or clear the filters.'}
            action={groups.length > 0 ? <button type="button" className="c-btn sm" onClick={() => { setView('all'); setSev('all'); setCat('all'); setProvider('all'); setQ(''); }}>Clear filters</button> : undefined}
          />
        ) : (
          <div className="c-tablewrap">
            <table className="c-table pg-alert-table">
              <thead>
                <tr>
                  <th className="c-check"><input type="checkbox" aria-label="Select all on this page" title="Select all on this page" checked={allSel}
                    onChange={() => setSelected(allSel ? new Set() : new Set(visible.map((g) => g.key)))} /></th>
                  <th>Severity</th>
                  <th>Plant</th>
                  <th>Fault</th>
                  <th>Category</th>
                  <th className="num">Count</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                  <th>Owner</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visible.map((g) => {
                  const st = stateOf(g);
                  const t = triage[g.key];
                  const open = expanded === g.key;
                  return (
                    <Fragment key={g.key}>
                      <tr aria-selected={selected.has(g.key)} aria-expanded={open} className={st !== 'open' ? 'pg-row-muted' : undefined}
                        tabIndex={0} onClick={() => setExpanded(open ? null : g.key)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(open ? null : g.key); } }}>
                        <td className="c-check" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" aria-label={`Select ${g.fault} at ${g.plant}`} checked={selected.has(g.key)} onChange={() => toggle(g.key)} />
                        </td>
                        <td><SeverityPill severity={g.severity} /></td>
                        <td className="name">
                          <strong title={g.plant}>{g.plant}</strong>
                          <span><ProviderChip id={g.provider} name={providerName(g.provider)} /></span>
                        </td>
                        <td className="pg-fault">
                          <span className="c-trunc" title={g.fault}>{g.fault}</span>
                          {g.code && <code className="c-mono">{g.code}</code>}
                        </td>
                        <td>{CATEGORY_LABEL[g.category]}</td>
                        <td className="num">{g.count > 1 ? <Pill tone="neutral">×{fmtInt(g.count)}</Pill> : '1'}</td>
                        <td>{g.firstSeen ? <RelTime t={g.firstSeen} /> : <span className="c-empty-val" title="The provider doesn’t report a start time">—</span>}</td>
                        <td>{g.lastSeen ? <RelTime t={g.lastSeen} /> : <span className="c-muted" title="Detected in the current scan">just now</span>}</td>
                        <td>
                          {st === 'ack' ? <Pill tone="success">Acknowledged</Pill>
                            : st === 'snoozed' ? <Pill tone="neutral" title={`Until ${fmtAbs(t?.snoozeUntil)}`}>Snoozed</Pill>
                              : t?.assignee ? <span className="c-trunc">{t.assignee === me ? 'You' : t.assignee}</span>
                                : <span className="c-empty-val">—</span>}
                        </td>
                        <td className="pg-actions" onClick={(e) => e.stopPropagation()}>
                          {st === 'open' && (
                            <button type="button" className="c-btn sm" onClick={() => ack([g.key])} title="Acknowledge">
                              <Icon name="check" size={14} /><span className="c-hide-sm">Ack</span>
                            </button>
                          )}
                          <Menu label={`Actions for ${g.fault} at ${g.plant}`} items={rowMenu(g)} />
                        </td>
                      </tr>
                      {open && (
                        <tr className="pg-expand">
                          <td colSpan={10}>
                            <AlertDetail
                              g={g}
                              providerName={providerName(g.provider)}
                              docs={docs}
                              ai={aiAnswers[g.key]}
                              aiBusy={aiBusy}
                              canAsk={canAsk}
                              onAi={(k) => void aiDraft(g, k)}
                              onOpenPlant={() => openPlant({ provider: g.provider, id: g.plantId })}
                              onOpenDraft={(id) => navigate('drafts', `?draft=${id}`)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <Pager paged={paged} noun="group" />
          </div>
        )}
      </section>
      <p className="pg-footnote">Acknowledge, assign and snooze are saved in this browser.</p>
    </div>
  );
}

function AlertDetail({ g, providerName, docs, ai, aiBusy, canAsk, onAi, onOpenPlant, onOpenDraft }: {
  g: AlertGroup; providerName: string; docs: IngestedDocument[] | null; ai?: Draft; aiBusy: string | null; canAsk: boolean;
  onAi: (k: 'fix' | 'email') => void; onOpenPlant: () => void; onOpenDraft: (id: number) => void;
}) {
  const timeline = [...g.items].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 12);
  const related = docs ? matchDocs(docs, { brand: brandTokens(g.provider, providerName), words: g.fault.split(/\W+/) }, 4) : null;
  return (
    <div className="pg-detail">
      <div className="pg-detail-col">
        <h3 className="c-h3">Timeline</h3>
        <ol className="pg-timeline">
          {timeline.map((a, i) => (
            <li key={`${a.id}:${i}`}>
              <span className="pg-tl-dot" />
              <div>
                <strong>{a.at ? fmtAbs(a.at) : 'Current scan'}</strong>
                <span>{a.deviceSn ? <code className="c-mono">{a.deviceSn}</code> : null}{a.status ? ` · ${a.status}` : ''}{a.detail && !a.detail.startsWith('Fault code') ? ` · ${a.detail}` : ''}</span>
              </div>
            </li>
          ))}
          {g.items.length > timeline.length && <li className="c-muted">+{fmtInt(g.items.length - timeline.length)} earlier occurrences</li>}
        </ol>
      </div>
      <div className="pg-detail-col">
        <dl className="c-dl">
          <div><dt>Fault code</dt><dd>{g.code ? <code className="c-mono">{g.code}</code> : '—'}</dd></div>
          <div><dt>Devices</dt><dd>{g.devices.length ? g.devices.map((d) => <code key={d} className="c-mono pg-sn">{d}</code>) : '—'}</dd></div>
          <div><dt>First seen</dt><dd>{fmtAbs(g.firstSeen)}</dd></div>
          <div><dt>Provider status</dt><dd>{g.providerStatus ?? '—'}</dd></div>
        </dl>
        {g.solution && (
          <div className="pg-solution">
            <h3 className="c-h3">Provider guidance</h3>
            <p>{g.solution}</p>
          </div>
        )}
        <div>
          <h3 className="c-h3">Related manuals</h3>
          {related == null ? <span className="c-skel" /> : related.length === 0 ? (
            <p className="c-muted">No matching {providerName} document in the knowledge base.</p>
          ) : (
            <ul className="pg-doclist">
              {related.map(({ d, type }) => (
                <li key={d.id}>
                  <Icon name="doc" size={16} />
                  {d.web_url ? <a href={d.web_url} target="_blank" rel="noreferrer" className="c-trunc" title={d.title}>{d.title}</a> : <span className="c-trunc" title={d.title}>{d.title}</span>}
                  <Pill tone="neutral">{type}</Pill>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="pg-detail-col pg-detail-ai">
        <h3 className="c-h3">AI assist</h3>
        {ai ? (
          <div className="pg-ai-answer" aria-live="polite">
            {ai.outcome !== 'answer' && <div className="c-banner t-warning"><Icon name="alert" size={16} /> Human review required — the agent wasn’t confident.</div>}
            <p>{ai.reply}</p>
            <button type="button" className="c-link" onClick={() => onOpenDraft(ai.id)}>Open in Drafts & approvals →</button>
          </div>
        ) : (
          <p className="c-muted">Get step-by-step diagnosis grounded in TSBA manuals. Results are drafts for review.</p>
        )}
        <div className="c-row">
          {canAsk && (
            <>
              <button type="button" className="c-btn sm primary" disabled={aiBusy != null} onClick={() => onAi('fix')}>
                <Icon name="ai" size={14} /> {aiBusy === `fix:${g.key}` ? 'Thinking…' : ai ? 'Ask again' : 'Ask AI how to fix'}
              </button>
              <button type="button" className="c-btn sm" disabled={aiBusy != null} onClick={() => onAi('email')}>
                <Icon name="mail" size={14} /> {aiBusy === `email:${g.key}` ? 'Drafting…' : 'Draft customer email'}
              </button>
            </>
          )}
          <button type="button" className="c-btn sm ghost" onClick={onOpenPlant}>Open plant <Icon name="chevron" size={14} /></button>
        </div>
      </div>
    </div>
  );
}
