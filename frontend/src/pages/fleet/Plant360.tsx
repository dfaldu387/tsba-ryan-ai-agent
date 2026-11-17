// Plant 360: one page that joins live status, alerts, equipment, KB documents
// (warranty / manual / datasheet auto-linked from the inverter model), past
// support threads and notes, plus an AI assistant pre-loaded with the plant's
// context whose answers land in Drafts & approvals.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AUDIENCE_LABELS, hasPermission, type Audience, type Draft, type IngestedDocument, type PlantContact,
} from '@tsba/shared';
import {
  AuthError, createDraft, getPlantContacts, getSolarStationDetail, getStationOverview, listDocuments, updatePlantContacts,
  type SolarStation, type SolarStationDetail, type StationOverview,
} from '../../api';
import { useConsole } from '../../lib/console';
import { brandTokens, matchDocs, plantQuestion } from '../../lib/aiActions';
import { EMPTY, fmtAbs, fmtInt, fmtKw, fmtKwh, fmtKwp, fmtPct, mask } from '../../lib/format';
import { OverviewSections } from '../../components/solar/kpis';
import { FlowPanel, flowFromDetail } from '../../components/solar/flow';
import { PowerChart } from '../../components/solar/charts';
import {
  DeviceStatePill, EmptyState, ErrorState, Icon, Pill, ProviderChip, RelTime, SeverityPill, SkeletonRows, StatusPill, Tabs, neverReported, usePaged, Pager,
} from '../../ui';
import { CATEGORY_LABEL } from '../../lib/alerts';

type Tab = 'overview' | 'alerts' | 'devices' | 'history' | 'documents' | 'notes';

const QUICK_ASKS = [
  'Why might this plant be underperforming today?',
  'Explain the active faults and how to fix them.',
  'What warranty applies to this inverter and battery?',
  'Write a short status update for the owner.',
];

export function Plant360({ station, tab: initialTab, onBack }: { station: SolarStation; tab?: string; onBack: () => void }) {
  const { providerName, openGroups, drafts, user, canSeePii, navigate, upsertDraft, toast, onAuthError, groups } = useConsole();
  const pname = providerName(station.provider);
  const [tab, setTab] = useState<Tab>(
    (['overview', 'alerts', 'devices', 'history', 'documents', 'notes'] as Tab[]).includes(initialTab as Tab) ? (initialTab as Tab) : 'overview',
  );
  const [detail, setDetail] = useState<SolarStationDetail | null>(null);
  const [detailErr, setDetailErr] = useState('');
  const [ov, setOv] = useState<StationOverview | null>(null);
  const [docs, setDocs] = useState<IngestedDocument[] | null>(null);
  const aiRef = useRef<HTMLTextAreaElement>(null);

  const load = () => {
    setDetail(null);
    setDetailErr('');
    getSolarStationDetail(station.provider, station.id)
      .then(setDetail)
      .catch((err) => { if (err instanceof AuthError) return onAuthError(); setDetailErr('The provider didn’t return this plant’s detail.'); });
    getStationOverview(station.provider, station.id).then(setOv).catch(() => setOv(null));
  };
  useEffect(() => {
    load();
    listDocuments().then((r) => setDocs(r.documents)).catch(() => setDocs([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station.provider, station.id]);

  useEffect(() => {
    if (initialTab === 'ai') aiRef.current?.focus();
  }, [initialTab]);

  // Equipment: device types + any model/serial facts the provider exposes.
  const equipment = useMemo(() => {
    const info = detail?.info ?? [];
    const pick = (re: RegExp) => info.filter((i) => re.test(i.label)).map((i) => i.value).filter(Boolean);
    const inverter = pick(/inverter.*(model|type)|^model|device model|machine/i);
    const battery = pick(/battery.*(model|type|brand)/i);
    const devices = detail?.devices ?? [];
    const models = [...new Set([...inverter, ...battery, ...devices.map((d) => d.type ?? '').filter(Boolean)])];
    // Equipment maker, when the provider is a monitoring platform rather than the
    // hardware brand (e.g. Solarman monitoring a SofarSolar inverter).
    const makers = pick(/^(manufacturer|brand|inverter (maker|brand|manufacturer))$/i);
    return { inverter, battery, devices, models, makers, serials: devices.map((d) => d.sn).filter(Boolean) };
  }, [detail]);

  const plantGroups = useMemo(
    () => groups.filter((g) => g.provider === station.provider && g.plantId === station.id),
    [groups, station],
  );
  const openCount = openGroups.filter((g) => g.provider === station.provider && g.plantId === station.id).length;

  const history = useMemo(() => {
    const keys = [station.name.toLowerCase(), ...equipment.serials.map((s) => s.toLowerCase())].filter((k) => k.length >= 4);
    return (drafts ?? [])
      .filter((d) => keys.some((k) => `${d.question} ${d.reply}`.toLowerCase().includes(k)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [drafts, station.name, equipment.serials]);

  const related = useMemo(
    () => {
      if (!docs) return null;
      const brand = [...new Set([
        ...brandTokens(station.provider, pname),
        ...equipment.makers.flatMap((m) => m.split(/,\s*/)).flatMap((m) => brandTokens(m, m)),
      ])];
      return matchDocs(docs, { brand, models: equipment.models }, 12);
    },
    [docs, station.provider, pname, equipment.models, equipment.makers],
  );

  const latest = detail?.latest;
  // House energy-flow: the provider's rich flow when it has one, else built from basic detail.
  const flow = useMemo(() => ov?.flow ?? (detail ? flowFromDetail(detail, station) : null), [ov, detail, station]);
  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: 'overview', label: 'Overview' },
    { value: 'alerts', label: 'Alerts', count: openCount },
    { value: 'devices', label: 'Devices', count: equipment.devices.length },
    { value: 'history', label: 'Support history', count: history.length },
    { value: 'documents', label: 'Documents', count: related?.length },
    { value: 'notes', label: 'Notes' },
  ];
  const devPaged = usePaged(equipment.devices, [station.provider, station.id]);

  return (
    <div className="p360">
      <header className="p360-head">
        <button type="button" className="c-btn sm ghost p360-back" onClick={onBack}><Icon name="chevron" size={14} className="flip" /> Plants</button>
        <div className="p360-title">
          <h2>{station.name}</h2>
          <div className="p360-meta">
            <StatusPill status={station.status} />
            <ProviderChip id={station.provider} name={pname} />
            {station.location && <span><Icon name="map" size={14} /> {canSeePii ? station.location : mask(station.location)}</span>}
            <span>Last data {neverReported(station) ? 'never reported' : <RelTime t={station.lastUpdate} stale />}</span>
          </div>
        </div>
        <dl className="p360-facts">
          <div><dt>Capacity</dt><dd>{fmtKwp(station.capacityKw)}</dd></div>
          <div><dt>Inverter</dt><dd>{equipment.inverter[0] ?? equipment.devices.find((d) => /inv/i.test(d.type ?? ''))?.type ?? (detail ? EMPTY : '…')}</dd></div>
          <div><dt>Battery</dt><dd>{equipment.battery[0] ?? (station.batterySoc != null ? `SOC ${fmtPct(station.batterySoc)}` : detail ? EMPTY : '…')}</dd></div>
          <div><dt>Serials</dt><dd>{equipment.serials.length ? equipment.serials.slice(0, 2).map((s) => <code key={s} className="c-mono">{s}</code>) : detail ? EMPTY : '…'}{equipment.serials.length > 2 && <span className="c-muted"> +{equipment.serials.length - 2}</span>}</dd></div>
        </dl>
      </header>

      {neverReported(station) && (
        <div className="c-banner t-warning" role="note">
          <Icon name="alert" size={16} />
          <span>{pname} has never sent data for this plant. It usually means no datalogger or inverter is linked to it there — check the plant in the {pname} portal.</span>
        </div>
      )}

      <div className="p360-grid">
        <div className="p360-main">
          <Tabs label="Plant sections" value={tab} onChange={setTab} tabs={tabs} />
          <div className="p360-panel" role="tabpanel">
            {tab === 'overview' && (
              <div className="p360-overview">
                <div className="p360-kpis">
                  <div><span>Now</span><b>{station.status === 'offline' ? EMPTY : fmtKw(latest?.currentPowerW ?? station.currentPowerW, 2)}</b></div>
                  <div><span>Today</span><b>{fmtKwh(latest?.dailyEnergyKwh ?? station.dailyEnergyKwh)}</b></div>
                  <div><span>This month</span><b>{fmtKwh(latest?.monthlyEnergyKwh ?? station.monthlyEnergyKwh)}</b></div>
                  <div><span>Lifetime</span><b>{fmtKwh(latest?.totalEnergyKwh ?? station.totalEnergyKwh)}</b></div>
                </div>
                {detailErr && <ErrorState title="Live detail unavailable" detail={detailErr} onRetry={load} />}
                {flow && <div className="solar-root"><FlowPanel flow={flow} overview={ov} station={station} detail={detail} /></div>}
                {ov && (ov.stats?.length || ov.powerCurve || ov.selfUse || ov.comparison) ? (
                  <div className="solar-root p360-rich"><OverviewSections overview={ov} /></div>
                ) : detail ? (
                  <div className="solar-root">
                    <h3 className="c-h3">Today’s generation</h3>
                    <PowerChart points={detail.power} />
                  </div>
                ) : !detailErr && <SkeletonRows rows={4} cols={3} />}
                {detail?.info?.length ? (
                  <details className="p360-info">
                    <summary>All plant details from {pname}</summary>
                    <dl className="c-dl">{detail.info.map((i) => <div key={i.label}><dt>{i.label}</dt><dd>{i.value}</dd></div>)}</dl>
                  </details>
                ) : null}
              </div>
            )}

            {tab === 'alerts' && (
              plantGroups.length === 0 && !(detail?.alerts.length) ? (
                <EmptyState tone="success" icon="check" title="No alerts for this plant" />
              ) : (
                <div className="p360-alerts">
                  {plantGroups.map((g) => (
                    <article key={g.key} className="p360-alert">
                      <div className="c-row">
                        <SeverityPill severity={g.severity} />
                        <strong>{g.fault}</strong>
                        {g.code && <code className="c-mono">{g.code}</code>}
                        <span className="c-muted">{CATEGORY_LABEL[g.category]} · ×{fmtInt(g.count)}</span>
                        <span className="c-grow" />
                        {g.lastSeen && <RelTime t={g.lastSeen} />}
                      </div>
                      {g.solution && <p className="p360-sol">{g.solution}</p>}
                      <button type="button" className="c-link" onClick={() => navigate('solar', `?view=alerts&open=${encodeURIComponent(g.key)}`)}>Triage in Alerts →</button>
                    </article>
                  ))}
                  {detail?.alerts.filter((a) => a.reason && !plantGroups.some((g) => g.fault === a.name)).map((a) => (
                    <article key={a.id} className="p360-alert">
                      <div className="c-row"><strong>{a.name}</strong>{a.code && <code className="c-mono">{a.code}</code>}{a.start && <span className="c-muted">since {fmtAbs(a.start)}</span>}</div>
                      <p className="p360-sol">{a.reason}</p>
                    </article>
                  ))}
                </div>
              )
            )}

            {tab === 'devices' && (
              !detail ? (detailErr ? <ErrorState detail={detailErr} onRetry={load} /> : <SkeletonRows rows={3} cols={3} />)
                : equipment.devices.length === 0 ? (
                  // Empty can mean "none linked" or a failed/rate-limited platform call — don't claim the platform lacks devices.
                  <EmptyState icon="monitor" title={`No devices returned by ${pname}`}
                    hint="The platform sent no device list for this plant just now. It may be busy — try again in a minute."
                    action={<button type="button" className="c-btn sm" onClick={load}>Retry</button>} />
                )
                  : (
                    <>
                    <table className="c-table">
                      <thead><tr><th>Serial</th><th>Type</th><th>State</th></tr></thead>
                      <tbody>
                        {devPaged.slice.map((d, i) => (
                          <tr key={`${d.sn}:${d.type ?? ''}:${devPaged.start + i}`} style={{ cursor: 'default' }}>
                            <td><code className="c-mono">{d.sn || EMPTY}</code></td>
                            <td>{d.type || EMPTY}</td>
                            <td><DeviceStatePill device={d} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <Pager paged={devPaged} noun="device" />
                    </>
                  )
            )}

            {tab === 'history' && (
              history.length === 0 ? (
                <EmptyState icon="inbox" title="No support threads mention this plant yet"
                  hint="Drafts that mention the plant name or a device serial appear here." />
              ) : (
                <ul className="p360-history">
                  {history.map((d) => (
                    <li key={d.id}>
                      <button type="button" onClick={() => navigate('drafts', `?draft=${d.id}`)}>
                        <span className="c-trunc"><strong>{d.question.split('\n')[0]}</strong></span>
                        <span className="c-row c-muted">
                          <Pill tone={d.status === 'pending' ? 'brand' : d.status === 'rejected' ? 'neutral' : 'success'}>{d.status}</Pill>
                          {AUDIENCE_LABELS[d.audience]} · <RelTime t={d.created_at} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            )}

            {tab === 'documents' && (
              related == null ? <SkeletonRows rows={4} cols={2} /> : related.length === 0 ? (
                <EmptyState icon="doc" title={`No ${pname} documents matched`}
                  hint="Documents are matched by brand and by the inverter/battery model the provider reports."
                  action={<button type="button" className="c-btn sm" onClick={() => navigate('knowledge')}>Open knowledge base</button>} />
              ) : (
                <ul className="p360-docs">
                  {(['warranty', 'manual', 'datasheet', 'other'] as const).map((t) => {
                    const list = related.filter((r) => r.type === t);
                    if (!list.length) return null;
                    return (
                      <li key={t}>
                        <h3 className="c-h3">{t === 'other' ? 'Other' : `${t[0].toUpperCase()}${t.slice(1)}s`}</h3>
                        <ul>
                          {list.map(({ d }) => (
                            <li key={d.id}>
                              <Icon name="doc" size={16} />
                              {d.web_url ? <a href={d.web_url} target="_blank" rel="noreferrer" className="c-trunc" title={d.title}>{d.title}</a> : <span className="c-trunc" title={d.title}>{d.title}</span>}
                              {d.text_quality && d.text_quality !== 'ok' && <Pill tone="warning">Needs OCR</Pill>}
                              <span className="c-muted"><RelTime t={d.ingested_at} /></span>
                            </li>
                          ))}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              )
            )}

            {tab === 'notes' && <PlantNotes station={station} canEdit={hasPermission(user.role, 'manage_connections')} />}
          </div>
        </div>

        <PlantAssistant station={station} providerName={pname} models={equipment.models} textareaRef={aiRef}
          onDraft={(d) => { upsertDraft(d); toast({ tone: 'success', text: 'Draft saved to Drafts & approvals', action: { label: 'Open', run: () => navigate('drafts', `?draft=${d.id}`) } }); }}
          onAuthError={onAuthError} canAsk={hasPermission(user.role, 'ask')} />
      </div>
    </div>
  );
}

function PlantAssistant({ station, providerName, models, textareaRef, onDraft, onAuthError, canAsk }: {
  station: SolarStation; providerName: string; models: string[]; textareaRef: React.RefObject<HTMLTextAreaElement>;
  onDraft: (d: Draft) => void; onAuthError: () => void; canAsk: boolean;
}) {
  const [ask, setAsk] = useState('');
  const [audience, setAudience] = useState<Audience>('installer');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Draft | null>(null);
  const [err, setErr] = useState('');

  async function submit(text: string) {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setErr('');
    try {
      const d = await createDraft({ question: plantQuestion(station, providerName, models, t), audience, channel: audience === 'customer' ? 'email' : 'chat' });
      setAnswer(d);
      setAsk('');
      onDraft(d);
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      setErr('The assistant couldn’t answer. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!canAsk) return null;
  return (
    <aside className="p360-ai" aria-label="Ask AI about this plant">
      <div className="p360-ai-h">
        <Icon name="ai" />
        <div>
          <h3>Ask AI about this plant</h3>
          <p>Knows this plant’s provider, capacity, status and equipment. Answers are saved as drafts for approval.</p>
        </div>
      </div>
      {!answer && !busy && (
        <div className="p360-ai-quick">
          {QUICK_ASKS.map((qa) => <button key={qa} type="button" className="c-chip" onClick={() => void submit(qa)}>{qa}</button>)}
        </div>
      )}
      <div aria-live="polite" className="p360-ai-out">
        {busy && <div className="p360-ai-busy"><span className="spin" /> Reading TSBA manuals…</div>}
        {err && <ErrorState title={err} />}
        {answer && (
          <div className="p360-ai-answer">
            {answer.outcome !== 'answer' && (
              <div className="c-banner t-warning"><Icon name="alert" size={16} /><span><b>Human review required.</b> The agent didn’t find enough in the knowledge base.</span></div>
            )}
            <p>{answer.reply}</p>
            {answer.sources.length > 0 && (
              <details><summary>Sources ({answer.sources.length})</summary><ul>{answer.sources.map((s) => <li key={s.id}>{s.title}</li>)}</ul></details>
            )}
          </div>
        )}
      </div>
      <form className="p360-ai-form" onSubmit={(e) => { e.preventDefault(); void submit(ask); }}>
        <label className="c-sr" htmlFor="p360-ask">Question about {station.name}</label>
        <textarea id="p360-ask" ref={textareaRef} className="c-textarea" value={ask} onChange={(e) => setAsk(e.target.value)}
          placeholder="e.g. Is the battery install compliant with AS/NZS 5139?" rows={3}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(ask); } }} />
        <div className="c-row">
          <select className="c-select" value={audience} onChange={(e) => setAudience(e.target.value as Audience)} aria-label="Answer for">
            <option value="installer">For an installer</option>
            <option value="customer">For the customer</option>
            <option value="sales">For sales</option>
          </select>
          <span className="c-grow" />
          <button type="submit" className="c-btn primary" disabled={busy || !ask.trim()}><Icon name="send" size={14} /> Ask</button>
        </div>
      </form>
    </aside>
  );
}

function PlantNotes({ station, canEdit }: { station: SolarStation; canEdit: boolean }) {
  const { toast, onAuthError, canSeePii } = useConsole();
  const key = `${station.provider}:${station.id}`;
  const [all, setAll] = useState<Record<string, PlantContact> | null>(null);
  const [form, setForm] = useState<PlantContact>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    getPlantContacts()
      .then((r) => { setAll(r.contacts); setForm(r.contacts[key] ?? {}); })
      .catch((e) => { if (e instanceof AuthError) onAuthError(); setAll({}); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!all) return <SkeletonRows rows={3} cols={2} />;
  const save = async () => {
    setSaving(true);
    try {
      // The API replaces the whole contacts map, so merge into a fresh copy:
      // saving this plant must not undo someone else's edit to another plant.
      const latest = await getPlantContacts().then((x) => x.contacts);
      const r = await updatePlantContacts({ ...latest, [key]: { ...form, plantName: station.name } });
      setAll(r.contacts);
      toast({ tone: 'success', text: 'Notes saved' });
    } catch (e) {
      if (e instanceof AuthError) return onAuthError();
      toast({ tone: 'danger', text: 'Couldn’t save the notes.' });
    } finally {
      setSaving(false);
    }
  };
  const field = (k: keyof PlantContact, label: string, type = 'text') => (
    <label className="p360-field">
      <span>{label}</span>
      {canEdit
        ? <input className="c-input" type={type} value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
        : <span>{form[k] ? (canSeePii ? form[k] : mask(form[k])) : EMPTY}</span>}
    </label>
  );
  return (
    <div className="p360-notes">
      <div className="p360-notes-grid">
        {field('name', 'Owner / contact')}
        {field('email', 'Email', 'email')}
        {field('phone', 'Phone', 'tel')}
      </div>
      <label className="p360-field">
        <span>Notes (site access, preferred contact hours…)</span>
        {canEdit
          ? <textarea className="c-textarea" value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          : <p>{form.notes || EMPTY}</p>}
      </label>
      {canEdit && <div><button type="button" className="c-btn primary" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save notes'}</button></div>}
    </div>
  );
}
