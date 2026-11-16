// Sales admin: the manager's side of the sales pipeline. Overview, every rep's
// pipeline, the text log, opt-outs, reps and team settings.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { KW_METRICS, KW_STAGES, hasPermission, kwStageLabel, type KwAdminClient, type KwStage, type KwAdminMessage, type KwMetric, type KwOptOut, type KwSettings, type User } from '@tsba/shared';
import { AuthError, createUser, kw, kwAdmin, listUsers, updateUser } from '../../api';
import { useConsole } from '../../lib/console';
import type { KwTeamRow, KwWarmth } from '../../lib/kw-types';
import { EmptyState, Icon, Pager, SearchInput, usePaged } from '../../ui';
import { Ring, TYPE_LABEL, WarmthTag, cadenceLabel, errText, fmtDate, fmtWhen } from './parts';
import { stageTotals } from './Board';

const money = (n: number) => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

/** Load once, with auth handling and a retry. */
function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const { onAuthError } = useConsole();
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    setErr(null);
    fn().then(setData).catch((e) => (e instanceof AuthError ? onAuthError() : setErr(errText(e))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(load, [load]);
  return { data, err, reload: load, setData };
}

function Frame({ title, sub, actions, children }: { title: string; sub?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="kw-admin kw-enter">
      <header className="kw-admin-head">
        <div>
          <h2 className="kw-h2">{title}</h2>
          {sub && <p className="kw-sub">{sub}</p>}
        </div>
        {actions && <div className="kw-admin-actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

function Loading({ err, onRetry }: { err: string | null; onRetry: () => void }) {
  return err
    ? <div className="kw-card"><p className="kw-err">{err}</p><button type="button" className="kw-btn kw-small-btn" onClick={onRetry}>Try again</button></div>
    : <div className="kw-think"><i />Loading…</div>;
}

// ─── Overview ───────────────────────────────────────────────────────────────
export function SalesOverview({ targets, onOpen }: { targets: Record<KwMetric, number>; onOpen: (v: string, search?: string) => void }) {
  const { data, err, reload } = useLoad(() => kw.team().then((r) => r.reps));
  const reps = data;
  const totals = useMemo(() => {
    const t = { clients: 0, overdue: 0, replies: 0, drafts: 0, followups: 0, pipeline: 0, revenue: 0, asIs: [] as number[] };
    for (const r of reps ?? []) {
      t.clients += r.clients; t.overdue += r.overdue; t.replies += r.waitingReplies; t.drafts += r.draftsWaiting;
      t.followups += r.week.followups; t.pipeline += r.week.pipeline; t.revenue += r.week.revenue;
      if (r.sentAsIsPct != null) t.asIs.push(r.sentAsIsPct);
    }
    return t;
  }, [reps]);

  return (
    <Frame title="Sales overview" sub="Activity this week, before it shows up in revenue.">
      {!reps ? <Loading err={err} onRetry={reload} /> : reps.length === 0 ? (
        <div className="kw-card kw-center kw-narrow">
          <div className="kw-name">No reps yet.</div>
          <p className="kw-small">Add your first sales rep. They set themselves up on first sign-in.</p>
          <button type="button" className="kw-btn kw-small-btn" onClick={() => onOpen('reps')}><Icon name="plus" size={15} /> Add a rep</button>
        </div>
      ) : (
        <>
          <div className="kw-kpis">
            <Kpi label="Clients in pipeline" value={totals.clients} onClick={() => onOpen('pipeline')} />
            <Kpi label="Need attention" value={totals.overdue} tone={totals.overdue ? 'bad' : 'good'} hint="Overdue 2+ days or no rhythm" onClick={() => onOpen('pipeline', 'attention')} />
            <Kpi label="Replies waiting" value={totals.replies} tone={totals.replies ? 'warn' : undefined} />
            <Kpi label="Follow-ups this week" value={totals.followups} hint={`Target ${targets.followups * 5 * reps.filter((r) => r.setUp).length}`} />
            <Kpi label="New clients this week" value={totals.pipeline} />
            <Kpi label="Sent as drafted" value={totals.asIs.length ? `${Math.round(totals.asIs.reduce((a, b) => a + b, 0) / totals.asIs.length)}%` : '–'} hint="Last 30 days. Low means drafts need work." />
          </div>

          <h3 className="kw-sec">Reps</h3>
          <div className="kw-team-cards">
            {reps.map((r) => <RepCard key={r.userId} r={r} onOpen={onOpen} />)}
          </div>

          <h3 className="kw-sec">This week against target</h3>
          <WeekTable reps={reps} targets={targets} />
        </>
      )}
    </Frame>
  );
}

function Kpi({ label, value, hint, tone, onClick }: { label: string; value: ReactNode; hint?: string; tone?: 'good' | 'bad' | 'warn'; onClick?: () => void }) {
  const body = (
    <>
      <span className="kw-kpi-l">{label}</span>
      <b className={tone ? `is-${tone}` : ''}>{value}</b>
      {hint && <span className="kw-kpi-h">{hint}</span>}
    </>
  );
  return onClick
    ? <button type="button" className="kw-card kw-kpi" onClick={onClick}>{body}</button>
    : <div className="kw-card kw-kpi">{body}</div>;
}

function RepCard({ r, onOpen }: { r: KwTeamRow; onOpen: (v: string, search?: string) => void }) {
  return (
    <div className="kw-card kw-team-card">
      <div className="kw-rowline">
        <div className="kw-grow">
          <div className="kw-name">{r.name}</div>
          <div className="kw-small">{r.setUp ? `Active ${r.lastActiveAt ? fmtWhen(r.lastActiveAt) : 'never'}` : 'Hasn’t set up yet'}</div>
        </div>
        {r.overdue > 0 ? <span className="kw-tag is-cold">{r.overdue} need attention</span> : r.setUp ? <span className="kw-tag is-warm">All warm</span> : <span className="kw-tag">Invited</span>}
      </div>
      <div className="kw-team-stats">
        <div><b>{r.clients}</b><span>Clients</span></div>
        <div><b>{r.waitingReplies}</b><span>Replies waiting</span></div>
        <div><b>{r.draftsWaiting}</b><span>Drafts waiting</span></div>
        <div><b>{r.sentAsIsPct == null ? '–' : `${r.sentAsIsPct}%`}</b><span>Sent as drafted</span></div>
      </div>
      {r.setUp && (
        <div className="kw-tools">
          <button type="button" className="kw-tool" onClick={() => onOpen('pipeline', `rep:${r.userId}`)}>Pipeline</button>
          <button type="button" className="kw-tool" onClick={() => onOpen('messages', `rep:${r.userId}`)}>Texts</button>
        </div>
      )}
    </div>
  );
}

function WeekTable({ reps, targets }: { reps: KwTeamRow[]; targets: Record<KwMetric, number> }) {
  return (
    <div className="kw-table-wrap">
      <table className="kw-table">
        <thead>
          <tr><th scope="col">Rep</th>{KW_METRICS.map((m) => <th key={m.k} scope="col">{m.label}</th>)}<th scope="col">Revenue</th></tr>
        </thead>
        <tbody>
          {reps.map((r) => (
            <tr key={r.userId}>
              <th scope="row">{r.name}</th>
              {KW_METRICS.map((m) => {
                const v = r.week[m.k];
                const target = targets[m.k] * 5;
                return <td key={m.k} className={target && v >= target ? 'is-hit' : ''}>{v}<small> / {target}</small></td>;
              })}
              <td>{money(r.week.revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Pipeline (every rep's clients) ─────────────────────────────────────────
type PipeFilter = 'all' | 'attention' | 'paused' | 'none' | 'stopped';
const WARMTH_RANK: Record<KwWarmth, number> = { paused: 0, cold: 1, due: 2, cooling: 3, warm: 4, stopped: 5 };

export function PipelineView({ preset }: { preset: string }) {
  const { data, err, reload } = useLoad(() => kwAdmin.pipeline().then((r) => r.clients));
  const [filter, setFilter] = useState<PipeFilter>(preset === 'attention' ? 'attention' : 'all');
  const [rep, setRep] = useState(preset.startsWith('rep:') ? preset.slice(4) : '');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<KwAdminClient | null>(null);
  const [stage, setStage] = useState<KwStage | ''>('');

  const reps = useMemo(() => [...new Map((data ?? []).map((c) => [c.repId, c.repName])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [data]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? [])
      .filter((c) => (!rep || c.repId === rep) && (!stage || c.dealStage === stage) && (!needle || `${c.name} ${c.stage} ${c.repName}`.toLowerCase().includes(needle)))
      .filter((c) => filter === 'all' ? c.warmth !== 'stopped'
        : filter === 'attention' ? ['cold', 'due', 'paused'].includes(c.warmth) || (!c.cadenceDays && !c.optedOut)
        : filter === 'paused' ? c.warmth === 'paused'
        : filter === 'none' ? !c.cadenceDays && !c.optedOut
        : c.optedOut)
      .sort((a, b) => WARMTH_RANK[a.warmth] - WARMTH_RANK[b.warmth] || a.warmthPct - b.warmthPct || a.name.localeCompare(b.name));
  }, [data, filter, rep, q, stage]);
  const paged = usePaged(list, [filter, rep, q, stage]);
  const scoped = useMemo(() => (data ?? []).filter((c) => !rep || c.repId === rep), [data, rep]);
  const totals = useMemo(() => stageTotals(scoped), [scoped]);

  return (
    <Frame title="Pipeline" sub="Every deal across the team: where it sits, what it’s worth, and how warm it is.">
      {!data ? <Loading err={err} onRetry={reload} /> : (
        <>
          <dl className="kp-totals">
            <div><dt>Open deals</dt><dd>{totals.openCount}</dd></div>
            <div><dt>Quoted value</dt><dd>{money(totals.openValue)}</dd></div>
            <div><dt>Weighted forecast</dt><dd>{money(totals.weighted)}</dd></div>
            <div><dt>Won this month</dt><dd>{money(totals.wonMonth)}</dd></div>
          </dl>
          <div className="kp-funnel" role="group" aria-label="Filter by stage">
            {KW_STAGES.map((s) => {
              const cs = scoped.filter((c) => c.dealStage === s.id);
              return (
                <button key={s.id} type="button" aria-pressed={stage === s.id} onClick={() => setStage(stage === s.id ? '' : s.id)}>
                  <span className={`kp-pill is-${s.id}`}>{s.label}</span>
                  <b>{cs.length}</b>
                  <span className="kw-small">{money(cs.reduce((t, c) => t + (c.dealValue ?? 0), 0))}</span>
                </button>
              );
            })}
          </div>
          <section className="c-section kw-panel">
          <div className="c-toolbar">
            <SearchInput value={q} onChange={setQ} label="Search pipeline" placeholder="Search clients, stages, reps" />
            <select className="c-select" value={rep} onChange={(e) => setRep(e.target.value)} aria-label="Rep">
              <option value="">All reps</option>
              {reps.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <div className="c-chips" role="group" aria-label="Filter">
              {([['all', 'Active'], ['attention', 'Need attention'], ['paused', 'Mid-conversation'], ['none', 'No rhythm'], ['stopped', 'Asked to stop']] as [PipeFilter, string][]).map(([f, l]) => (
                <button key={f} type="button" className={`c-chip ${filter === f ? 'on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{l}</button>
              ))}
            </div>
          </div>
          {list.length === 0 ? <EmptyState icon="users" title="No deals match" hint="Try another stage, rep or filter." /> : (
            <div className="kw-table-wrap is-flush">
              <table className="kw-table kw-table-left">
                <thead><tr><th scope="col">Client</th><th scope="col">Rep</th><th scope="col">Stage</th><th scope="col">Value</th><th scope="col">In stage</th><th scope="col">Warmth</th><th scope="col">Rhythm</th><th scope="col">Next text</th><th scope="col">Last contact</th></tr></thead>
                <tbody>
                  {paged.slice.map((c) => (
                    <tr key={c.id} className="is-click" onClick={() => setOpen(c)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(c)}>
                      <th scope="row"><span className="kw-rowline"><Ring client={c} size={30} /> {c.name}</span></th>
                      <td>{c.repName}</td>
                      <td><span className={`kp-pill is-${c.dealStage}`}>{kwStageLabel(c.dealStage)}</span></td>
                      <td>{c.dealValue != null ? money(c.dealValue) : '–'}</td>
                      <td>{c.daysInStage}d</td>
                      <td><WarmthTag warmth={c.warmth} /></td>
                      <td>{c.cadenceDays ? `${cadenceLabel(c.cadenceDays)} · ${c.mix}` : '–'}</td>
                      <td>{c.paused ? 'Paused' : fmtDate(c.nextDue) || '–'}</td>
                      <td>{c.daysSinceContact == null ? 'Never' : c.daysSinceContact === 0 ? 'Today' : `${c.daysSinceContact}d ago`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager paged={paged} noun="client" />
            </div>
          )}
          </section>
          {open && <ClientPeek client={open} onClose={() => setOpen(null)} />}
        </>
      )}
    </Frame>
  );
}

/** Read-only look at another rep's client: notes and texts. */
function ClientPeek({ client, onClose }: { client: KwAdminClient; onClose: () => void }) {
  const { data } = useLoad(() => kwAdmin.messages({ q: client.name, rep: client.repId }).then((r) => r.messages.filter((m) => m.clientId === client.id)), [client.id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="kw-peek-scrim" onClick={onClose}>
      <aside className="kw-peek" role="dialog" aria-label={client.name} onClick={(e) => e.stopPropagation()}>
        <div className="kw-rowline">
          <Ring client={client} size={48} />
          <div className="kw-grow"><h3 className="kw-h2">{client.name}</h3><div className="kw-small">{client.repName}’s client · {kwStageLabel(client.dealStage)}{client.dealValue != null ? ` · ${money(client.dealValue)}` : ''}</div></div>
          <button type="button" className="kw-iconbtn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <WarmthTag warmth={client.warmth} />
        <h4 className="kw-sec">What {client.repName.split(' ')[0]} knows</h4>
        {client.notes.length ? <ul className="kw-peek-notes">{client.notes.map((n) => <li key={n.id}>{n.text}</li>)}</ul> : <p className="kw-small">No notes.</p>}
        <h4 className="kw-sec">Texts</h4>
        {!data ? <div className="kw-think"><i /></div> : data.length === 0 ? <p className="kw-small">No texts yet.</p> : (
          <div className="kw-thread">
            {[...data].reverse().filter((m) => m.status !== 'draft' && m.status !== 'skipped').map((m) => (
              <div key={m.id} className={`kw-msg is-${m.direction} ${m.status !== 'sent' && m.status !== 'received' ? `is-${m.status}` : ''}`}>
                {m.body}<small>{m.status === 'sent' || m.status === 'received' ? fmtWhen(m.sentAt ?? m.createdAt) : m.status}</small>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

// ─── Text log ───────────────────────────────────────────────────────────────
const STATUS_LABEL: Record<string, string> = {
  sent: 'Sent', received: 'Reply', scheduled: 'Waiting to send', held: 'Held (they replied)', failed: 'Failed', skipped: 'Skipped', draft: 'Draft',
};

export function MessageLog({ preset }: { preset: string }) {
  const [status, setStatus] = useState('');
  const [rep, setRep] = useState(preset.startsWith('rep:') ? preset.slice(4) : '');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 300); return () => clearTimeout(t); }, [q]);
  const { data, err, reload } = useLoad(() => kwAdmin.messages({ status, rep, q: debounced }).then((r) => r.messages), [status, rep, debounced]);
  const team = useLoad(() => kw.team().then((r) => r.reps));
  const paged = usePaged(data ?? [], [status, rep, debounced]);

  return (
    <Frame title="Text log" sub="Every text the team approved, and every reply. Unapproved drafts are left out unless you filter for them.">
      {/* Same shape as every console list: one card, toolbar on top, rows, count/pager in the footer. */}
      <section className="c-section kw-panel">
        <div className="c-toolbar">
          <SearchInput value={q} onChange={setQ} label="Search texts" placeholder="Search texts or clients" />
          <select className="c-select" value={rep} onChange={(e) => setRep(e.target.value)} aria-label="Rep">
            <option value="">All reps</option>
            {(team.data ?? []).filter((r) => r.setUp).map((r) => <option key={r.userId} value={r.userId}>{r.name}</option>)}
          </select>
          <select className="c-select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">Sent &amp; replies</option>
            {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        {!data ? <div className="kw-panel-pad"><Loading err={err} onRetry={reload} /></div> : data.length === 0 ? (
          <EmptyState icon="chat" title={q || rep || status ? 'No texts match these filters' : 'No texts yet'}
            hint={q || rep || status ? 'Try clearing the search or choosing All reps.' : 'Approved texts and client replies show up here.'} />
        ) : (
          <>
            <ol className="kw-log">{paged.slice.map((m) => <LogRow key={m.id} m={m} />)}</ol>
            <Pager paged={paged} noun="text" />
          </>
        )}
      </section>
    </Frame>
  );
}

function LogRow({ m }: { m: KwAdminMessage }) {
  return (
    <li className={`kw-log-row is-${m.direction}`}>
      <div className="kw-rowline">
        <Icon name={m.direction === 'in' ? 'chat' : 'send'} size={15} />
        <span className="c-sr">{m.direction === 'in' ? 'Reply from client:' : 'Text to client:'}</span>
        <span className="kw-name kw-clip">{m.direction === 'in' ? `${m.clientName} → ${m.repName}` : `${m.repName} → ${m.clientName}`}</span>
        <span className={`kw-tag is-st-${m.status}`}>{STATUS_LABEL[m.status] ?? m.status}</span>
        {m.direction === 'out' && <span className={`kw-tag is-${m.type}`}>{TYPE_LABEL[m.type]}</span>}
        {m.sentBy === 'agent' && <span className="kw-tag is-auto">Sent by agent</span>}
        <span className="kw-small kw-log-when">{fmtWhen(m.sentAt ?? m.scheduledFor ?? m.createdAt)}</span>
      </div>
      <p className="kw-log-body">{m.body || <em>(empty)</em>}</p>
      {m.error && m.status !== 'sent' && <p className="kw-small">{m.error}</p>}
    </li>
  );
}

// ─── Opt-outs ───────────────────────────────────────────────────────────────
export function OptOutList() {
  const { data, err, reload } = useLoad(() => kwAdmin.optOuts().then((r) => r.optOuts));
  const paged = usePaged<KwOptOut>(data ?? []);
  return (
    <Frame title="Opt-outs" sub="Numbers that asked to stop. They never get another text from this system, from any rep, even if they’re added again. This list is your record for the Spam Act.">
      {!data ? <Loading err={err} onRetry={reload} /> : data.length === 0 ? (
        <div className="kw-card kw-center"><div className="kw-name">Nobody has opted out.</div><p className="kw-small">When a client replies STOP (or “don’t text me”), they appear here straight away.</p></div>
      ) : (
        <div className="kw-table-wrap">
          <table className="kw-table kw-table-left">
            <thead><tr><th scope="col">Number</th><th scope="col">Client</th><th scope="col">Rep</th><th scope="col">How</th><th scope="col">When</th></tr></thead>
            <tbody>
              {paged.slice.map((o) => (
                <tr key={o.phone}>
                  <th scope="row">{o.phone}</th>
                  <td>{o.clients.map((c) => c.name).join(', ') || <span className="kw-small">Client since deleted</span>}</td>
                  <td>{[...new Set(o.clients.map((c) => c.repName))].join(', ') || '–'}</td>
                  <td>{o.source === 'sms' ? 'Replied STOP' : o.source}</td>
                  <td>{fmtWhen(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager paged={paged} noun="number" />
        </div>
      )}
    </Frame>
  );
}

// ─── Reps ───────────────────────────────────────────────────────────────────
export function RepsView() {
  const { user, toast } = useConsole();
  const canManage = hasPermission(user.role, 'manage_users');
  const team = useLoad(() => kw.team().then((r) => r.reps));
  const users = useLoad<User[]>(() => (canManage ? listUsers().then((r) => r.users) : Promise.resolve([])));
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);

  const disabledReps = (users.data ?? []).filter((u) => u.role === 'rep' && u.disabled);
  const reload = () => { team.reload(); users.reload(); };

  const add = async () => {
    setBusy(true);
    try {
      await createUser({ name: form.name.trim(), email: form.email.trim(), password: form.password, role: 'rep' });
      toast({ text: `${form.name.trim()} added. Send them the sign-in details yourself.`, tone: 'success' });
      setForm({ name: '', email: '', password: '' });
      setAdding(false);
      reload();
    } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
    finally { setBusy(false); }
  };
  const setDisabled = async (id: string, disabled: boolean, name: string) => {
    try {
      await updateUser(id, { disabled });
      toast({ text: disabled ? `${name} can no longer sign in. Their clients and history are kept.` : `${name} re-enabled.`, tone: 'info' });
      reload();
    } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
  };

  return (
    <Frame title="Reps" sub="Who uses the follow-up agent. Each rep sees only their own clients."
      actions={canManage && !adding ? <button type="button" className="kw-btn kw-small-btn" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Add a rep</button> : undefined}>
      {adding && (
        <div className="kw-card kw-addrep">
          <div className="kw-name">New sales rep</div>
          <div className="kw-form-grid">
            <label>Name<input className="kw-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="off" /></label>
            <label>Email<input className="kw-input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="off" /></label>
            <label>Temporary password<input className="kw-input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" /></label>
          </div>
          <p className="kw-small">They’ll set up their name, sign-off and business description themselves on first sign-in (about two minutes).</p>
          <div className="kw-tools">
            <button type="button" className="kw-btn kw-small-btn" disabled={busy || !form.name.trim() || !form.email.includes('@') || form.password.length < 8} onClick={add}>{busy ? 'Adding…' : 'Add rep'}</button>
            <button type="button" className="kw-tool" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
      {!canManage && <p className="kw-small">Only admins can add or remove reps. Ask an admin, or use Users &amp; roles.</p>}
      {!team.data ? <Loading err={team.err} onRetry={team.reload} /> : (
        <div className="kw-table-wrap">
          <table className="kw-table kw-table-left">
            <thead><tr><th scope="col">Rep</th><th scope="col">Status</th><th scope="col">Clients</th><th scope="col">Need attention</th><th scope="col">Sent as drafted</th><th scope="col">Last active</th>{canManage && <th scope="col"><span className="kw-sr">Actions</span></th>}</tr></thead>
            <tbody>
              {team.data.map((r) => (
                <tr key={r.userId}>
                  <th scope="row">{r.name}<div className="kw-small">{r.email}</div></th>
                  <td>{r.setUp ? <span className="kw-tag is-warm">Set up</span> : <span className="kw-tag">Not set up</span>}</td>
                  <td>{r.clients}</td>
                  <td>{r.overdue ? <span className="kw-tag is-cold">{r.overdue}</span> : 0}</td>
                  <td>{r.sentAsIsPct == null ? '–' : `${r.sentAsIsPct}%`}</td>
                  <td>{r.lastActiveAt ? fmtWhen(r.lastActiveAt) : 'Never'}</td>
                  {canManage && <td><button type="button" className="kw-tool" onClick={() => setDisabled(r.userId, true, r.name)}>Disable</button></td>}
                </tr>
              ))}
              {disabledReps.map((u) => (
                <tr key={u.id} className="is-muted">
                  <th scope="row">{u.name || u.email}<div className="kw-small">{u.email}</div></th>
                  <td><span className="kw-tag is-stopped">Disabled</span></td>
                  <td colSpan={4} />
                  <td><button type="button" className="kw-tool" onClick={() => setDisabled(u.id, false, u.name || u.email)}>Enable</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Frame>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────
export function SalesSettings({ onSaved }: { onSaved: () => void }) {
  const { toast } = useConsole();
  const { data, err, reload } = useLoad(() => kwAdmin.settings());
  const [draft, setDraft] = useState<KwSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setDraft(data.settings); }, [data]);

  if (!data || !draft) return <Frame title="Sales settings"><Loading err={err} onRetry={reload} /></Frame>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);

  const save = async () => {
    setBusy(true);
    try {
      const r = await kwAdmin.saveSettings(draft);
      setDraft(r.settings);
      reload();
      onSaved();
      toast({ text: 'Settings saved', tone: 'success' });
    } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
    finally { setBusy(false); }
  };

  return (
    <Frame title="Sales settings" sub="Applies to every rep.">
      <section className="kw-card kw-settings">
        <div className="kw-name">Daily targets</div>
        <p className="kw-small">What a good day looks like for each input. The week target is five times this. Follow-ups and pipeline additions count themselves.</p>
        <div className="kw-form-grid">
          {KW_METRICS.map((m) => (
            <label key={m.k}>{m.label}
              <input className="kw-input" type="number" min={0} max={1000} value={draft.targets[m.k]}
                onChange={(e) => setDraft({ ...draft, targets: { ...draft.targets, [m.k]: Number(e.target.value) } })} />
            </label>
          ))}
        </div>
      </section>

      <section className="kw-card kw-settings">
        <div className="kw-name">When texts can go out</div>
        <p className="kw-small">In each rep’s own time zone. Texts approved outside these hours wait until the window opens. Sundays are always off.</p>
        <div className="kw-form-grid">
          <label>Earliest<input className="kw-input" type="time" min="07:00" max="12:00" value={draft.quietStart} onChange={(e) => setDraft({ ...draft, quietStart: e.target.value })} /></label>
          <label>Latest<input className="kw-input" type="time" min="15:00" max="21:00" value={draft.quietEnd} onChange={(e) => setDraft({ ...draft, quietEnd: e.target.value })} /></label>
        </div>
      </section>

      <section className="kw-card kw-settings">
        <div className="kw-name">Pipeline agent</div>
        <p className="kw-small">The agent reviews every rep’s deals every 30 minutes and whenever a client replies. Choose how much it does without asking. It never sends a text either way.</p>
        <div className="kw-chips" role="radiogroup" aria-label="Agent mode">
          {([['suggest', 'Suggest only'], ['assist', 'Handle routine moves']] as const).map(([id, label]) => (
            <button key={id} type="button" role="radio" className="kw-chip" aria-checked={draft.agentMode === id} aria-pressed={draft.agentMode === id}
              onClick={() => setDraft({ ...draft, agentMode: id })}>{label}</button>
          ))}
        </div>
        <p className="kw-small">{draft.agentMode === 'assist'
          ? 'Moves deals itself when it’s clear-cut (a client books a visit, a lead has been texted). Won and Lost always stay with the rep. Every move is logged with an undo.'
          : 'Every stage change waits for the rep to confirm.'}</p>
      </section>

      <section className="kw-card kw-settings">
        <div className="kw-name">Agent answers routine replies</div>
        <p className="kw-small">
          When on, the agent replies to simple messages by itself in the rep’s name: thanks, confirming a time already agreed, simple questions the notes answer.
          It hands anything about price, the quote, complaints, a request for a call, or anything it isn’t sure about to the rep, and sends at most 3 texts per client a day.
          It waits 2 minutes before sending, and stops the moment the rep types, sends a text or taps Take over.
        </p>
        <p className="kw-small kp-warnline"><Icon name="alert" size={14} /> This relaxes the rule that the rep approves every text. Switch it on only once that change is signed off.</p>
        <div className="kw-chips" role="radiogroup" aria-label="Auto-replies">
          {([[false, 'Off: reps approve every reply'], [true, 'On: agent answers routine replies']] as const).map(([v, label]) => (
            <button key={String(v)} type="button" role="radio" className="kw-chip" aria-checked={draft.autoReply === v} aria-pressed={draft.autoReply === v}
              onClick={() => setDraft({ ...draft, autoReply: v })}>{label}</button>
          ))}
        </div>
      </section>

      <section className="kw-card kw-settings">
        <div className="kw-name">Connections</div>
        <dl className="kw-dl">
          <div><dt>Text messages</dt><dd>{data.sms.mode === 'twilio' ? <><span className="kw-tag is-warm">Live</span> Sending from {data.sms.from ?? 'each rep’s number'}</> : <><span className="kw-tag is-cold">Test mode</span> Approved texts are recorded but not delivered. Connect an SMS provider in the server settings to go live.</>}</dd></div>
          <div><dt>AI drafting</dt><dd>{data.ai ? <><span className="kw-tag is-warm">On</span> Claude writes drafts from each rep’s notes</> : <><span className="kw-tag is-cold">Off</span> Simple templates only. Set the AI key on the server.</>}</dd></div>
        </dl>
      </section>

      <section className="kw-card kw-settings kw-rules">
        <div className="kw-name">Always on</div>
        <ul>
          <li>{draft.autoReply ? 'Every text is approved by the rep, except routine replies the agent answers (above).' : 'Every text is approved by the rep. Nothing sends on its own.'}</li>
          <li>Texts come from the rep, in their name and voice.</li>
          <li>Friendly check-ins never sell.</li>
          <li>A client reply pauses their rhythm until the rep answers.</li>
          <li>STOP means stop, forever, for every rep.</li>
        </ul>
      </section>

      <div className={`kw-admin-save ${dirty ? 'is-dirty' : ''}`}>
        <button type="button" className="kw-btn" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button>
        {dirty && <button type="button" className="kw-tool" onClick={() => setDraft(data.settings)}>Discard changes</button>}
      </div>
    </Frame>
  );
}
