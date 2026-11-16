// Drafts & approvals: two-pane review queue. Left = drafts by state; right =
// the draft with grounding, cited sources (collapsed), audience, safety flags
// and the actions Approve & send · Edit · Regenerate · Escalate · Reject.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AUDIENCE_LABELS, AUDIENCES, CHANNEL_LABELS, CHANNELS, hasPermission,
  type Audience, type Channel, type Draft,
} from '@tsba/shared';
import { ApiError, AuthError, createDraft, flagVoiceAnswer, patchDraft } from '../api';
import { useConsole } from '../lib/console';
import { fmtAbs, fmtInt, mask } from '../lib/format';
import { SUGGESTIONS } from '../data/suggestions';
import {
  Drawer, EmptyState, Icon, Pill, RelTime, SearchInput, SkeletonRows, Tabs, usePref, type Tone,
} from '../ui';
import './pages.css';

type Bucket = 'pending' | 'review' | 'team' | 'sent' | 'rejected';
const BUCKET_LABEL: Record<Bucket, string> = { pending: 'Ready to approve', review: 'Needs review', team: 'With team', sent: 'Sent', rejected: 'Rejected' };

const bucketOf = (d: Draft): Bucket =>
  d.status === 'pending' ? (d.outcome === 'answer' ? 'pending' : 'review') : d.status === 'team' ? 'team' : d.status === 'sent' ? 'sent' : 'rejected';

const SAFETY: { re: RegExp; label: string }[] = [
  { re: /AS\/?NZS\s*5139|5139/i, label: 'AS/NZS 5139' },
  { re: /batter|bms|lithium|cell/i, label: 'Battery' },
  { re: /electric|wiring|isolat|ac side|dc side|voltage|switchboard|breaker|earth/i, label: 'Electrical' },
  { re: /fire|smoke|burn|overheat|thermal/i, label: 'Fire risk' },
];
export function safetyFlags(text: string): string[] {
  return SAFETY.filter((s) => s.re.test(text)).map((s) => s.label);
}

function grounding(d: Draft): { label: string; tone: Tone; detail: string } {
  const n = d.sources.length;
  if (d.outcome !== 'answer') return { label: 'Low confidence', tone: 'warning', detail: 'The agent flagged that it lacks information.' };
  if (n >= 2) return { label: 'Well grounded', tone: 'success', detail: `Backed by ${n} knowledge-base sources.` };
  if (n === 1) return { label: 'Partly grounded', tone: 'warning', detail: 'Backed by a single source — check it.' };
  return { label: 'Not grounded', tone: 'danger', detail: 'No knowledge-base source was cited.' };
}

const QUICK_INFO = ['Model number', 'Serial number', 'Install date', 'Photo of the fault screen', 'Battery model'];

export function DraftsPage({ search }: { search: string }) {
  const { drafts, refreshDrafts, upsertDraft, user, toast, onAuthError, canSeePii } = useConsole();
  const canApprove = hasPermission(user.role, 'approve_drafts');
  const canAsk = hasPermission(user.role, 'ask');
  const params = useMemo(() => new URLSearchParams(search), [search]);

  const [bucket, setBucket] = useState<Bucket>('pending');
  const [audience, setAudience] = useState<Audience | 'all'>('all');
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState<number | null>(params.get('draft') ? Number(params.get('draft')) : null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [reasons, setReasons] = usePref<Record<number, string>>('drafts.rejectReasons', {});
  const listRef = useRef<HTMLUListElement>(null);

  // Deep link (?draft=id) → select it and switch to its bucket.
  useEffect(() => {
    const id = Number(params.get('draft'));
    if (!id || !drafts) return;
    const d = drafts.find((x) => x.id === id);
    if (d) { setSelId(id); setBucket(bucketOf(d)); }
  }, [params, drafts]);

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { pending: 0, review: 0, team: 0, sent: 0, rejected: 0 };
    for (const d of drafts ?? []) c[bucketOf(d)] += 1;
    return c;
  }, [drafts]);

  const list = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (drafts ?? [])
      .filter((d) => bucketOf(d) === bucket && (audience === 'all' || d.audience === audience))
      .filter((d) => !terms.length || terms.every((t) => `${d.question} ${d.reply} ${d.recipient ?? ''}`.toLowerCase().includes(t)))
      .sort((a, b) => (bucket === 'pending' || bucket === 'review' ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)));
  }, [drafts, bucket, audience, q]);

  const selected = (drafts ?? []).find((d) => d.id === selId) ?? null;
  useEffect(() => {
    if (selected && bucketOf(selected) === bucket) return;
    if (window.matchMedia('(min-width: 961px)').matches) setSelId(list[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket, list.length]);

  const next = (afterId: number) => {
    const i = list.findIndex((d) => d.id === afterId);
    const n = list[i + 1] ?? list[i - 1];
    setSelId(n && n.id !== afterId ? n.id : null);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = list.findIndex((d) => d.id === selId);
    const n = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (n) {
      setSelId(n.id);
      listRef.current?.querySelector<HTMLElement>(`[data-id="${n.id}"]`)?.focus();
    }
  };

  const handleErr = (err: unknown, msg: string) => {
    if (err instanceof AuthError) return onAuthError();
    if (err instanceof ApiError && err.code === 'llm_not_configured') toast({ tone: 'danger', text: 'Live drafting is off on the server.' });
    else toast({ tone: 'danger', text: msg });
  };

  return (
    <div className={`dr ${selected ? 'has-sel' : ''}`}>
      <aside className="dr-list" aria-label="Drafts">
        <div className="dr-list-h">
          <Tabs label="Draft state" value={bucket} onChange={setBucket}
            tabs={(['pending', 'review', 'team', 'sent', 'rejected'] as Bucket[]).map((b) => ({ value: b, label: BUCKET_LABEL[b], count: b === 'pending' || b === 'review' ? counts[b] : undefined }))} />
          <div className="dr-list-tools">
            <SearchInput value={q} onChange={setQ} label="Search drafts" placeholder="Search drafts…" />
            <select className="c-select" value={audience} onChange={(e) => setAudience(e.target.value as Audience | 'all')} aria-label="Audience">
              <option value="all">All audiences</option>
              {AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABELS[a]}</option>)}
            </select>
            {canAsk && <button type="button" className="c-btn primary sm" onClick={() => setComposeOpen(true)}><Icon name="plus" size={14} /> New</button>}
          </div>
        </div>
        {drafts == null ? <SkeletonRows rows={6} cols={1} /> : list.length === 0 ? (
          <EmptyState tone={bucket === 'pending' || bucket === 'review' ? 'success' : 'neutral'} icon={bucket === 'pending' || bucket === 'review' ? 'check' : 'drafts'}
            title={bucket === 'pending' ? 'No drafts waiting for approval' : bucket === 'review' ? 'Nothing needs human review' : `No ${BUCKET_LABEL[bucket].toLowerCase()} drafts`}
            hint={q || audience !== 'all' ? 'Try clearing the search or audience filter.' : undefined}
            action={canAsk && bucket === 'pending' ? <button type="button" className="c-btn sm" onClick={() => setComposeOpen(true)}>Draft a reply</button> : undefined} />
        ) : (
          <ul className="dr-items" ref={listRef} onKeyDown={onListKey}>
            {list.map((d) => {
              const flags = safetyFlags(`${d.question} ${d.reply}`);
              return (
                <li key={d.id}>
                  <button type="button" data-id={d.id} className="dr-item" aria-current={d.id === selId ? 'true' : undefined} onClick={() => setSelId(d.id)}>
                    <span className="dr-item-top">
                      <Pill tone="neutral">{AUDIENCE_LABELS[d.audience]}</Pill>
                      <span className="c-muted">{CHANNEL_LABELS[d.channel]}</span>
                      <span className="c-grow" />
                      <RelTime t={d.created_at} />
                    </span>
                    <strong className="dr-item-q">{d.question}</strong>
                    <span className="dr-item-snip">{d.reply}</span>
                    {(flags.length > 0 || d.outcome !== 'answer') && (
                      <span className="dr-item-flags">
                        {d.outcome !== 'answer' && <Pill tone="warning" dot>Human review</Pill>}
                        {flags.slice(0, 2).map((f) => <Pill key={f} tone="danger">{f}</Pill>)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="dr-list-f c-muted">{fmtInt(list.length)} shown · ↑↓ to move</div>
      </aside>

      <section className="dr-pane" aria-label="Draft" aria-live="polite">
        {selected ? (
          <DraftCard
            key={selected.id}
            draft={selected}
            canApprove={canApprove}
            canAsk={canAsk}
            canSeePii={canSeePii}
            rejectReason={reasons[selected.id]}
            onBack={() => setSelId(null)}
            onUpdated={(d, opts) => {
              upsertDraft(d);
              if (opts?.advance) next(selected.id);
            }}
            onCreated={(d) => { upsertDraft(d); setSelId(d.id); setBucket(bucketOf(d)); }}
            onRejectReason={(reason) => setReasons({ ...reasons, [selected.id]: reason })}
            onError={handleErr}
            toast={toast}
            refresh={refreshDrafts}
          />
        ) : (
          <EmptyState icon="drafts" title="Select a draft" hint="Every AI reply is a draft. Nothing is sent until a person approves it." />
        )}
      </section>

      {composeOpen && (
        <Composer onClose={() => setComposeOpen(false)} onCreated={(d) => { upsertDraft(d); setSelId(d.id); setBucket(bucketOf(d)); setComposeOpen(false); }} onError={handleErr} />
      )}
    </div>
  );
}

function DraftCard({
  draft: d, canApprove, canAsk, canSeePii, rejectReason, onBack, onUpdated, onCreated, onRejectReason, onError, toast, refresh,
}: {
  draft: Draft; canApprove: boolean; canAsk: boolean; canSeePii: boolean; rejectReason?: string;
  onBack: () => void;
  onUpdated: (d: Draft, opts?: { advance?: boolean }) => void;
  onCreated: (d: Draft) => void;
  onRejectReason: (r: string) => void;
  onError: (err: unknown, msg: string) => void;
  toast: ReturnType<typeof useConsole>['toast'];
  refresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(d.reply);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<null | 'reject' | 'escalate' | 'info'>(null);
  const [note, setNote] = useState('');
  const [infoLabel, setInfoLabel] = useState('');
  const g = grounding(d);
  const flags = safetyFlags(`${d.question} ${d.reply}`);
  const pending = d.status === 'pending';
  const review = d.outcome !== 'answer';

  async function approve() {
    setBusy('approve');
    try {
      const updated = await patchDraft(d.id, { action: 'approve', text: text.trim() });
      onUpdated(updated, { advance: true });
      toast({ tone: 'success', text: updated.status === 'team' ? 'Holding reply sent; question is with the team' : 'Approved and sent' });
    } catch (err) { onError(err, 'Approval didn’t go through.'); } finally { setBusy(null); }
  }
  async function saveEdit() {
    setEditing(false);
    if (text.trim() === d.reply.trim()) return;
    setBusy('edit');
    try { onUpdated(await patchDraft(d.id, { action: 'edit', text: text.trim() })); toast({ text: 'Edits saved' }); }
    catch (err) { onError(err, 'Couldn’t save the edit.'); } finally { setBusy(null); }
  }
  async function reject(reason: string) {
    setBusy('reject');
    try {
      const updated = await patchDraft(d.id, { action: 'reject' });
      if (reason) onRejectReason(reason);
      onUpdated(updated, { advance: true });
      setMode(null);
      toast({ text: 'Draft rejected' });
    } catch (err) { onError(err, 'Couldn’t reject the draft.'); } finally { setBusy(null); }
  }
  async function regenerate(extra?: string) {
    setBusy('regen');
    try {
      const question = extra ? `${d.question}\n\nAdditional information: ${extra}` : d.question;
      const fresh = await createDraft({ question, audience: d.audience, channel: d.channel, recipient: d.recipient });
      await patchDraft(d.id, { action: 'reject' }).then(onUpdated).catch(() => undefined);
      onRejectReason('Superseded by a regenerated draft');
      onCreated(fresh);
      setMode(null);
      toast({ tone: 'success', text: 'New draft generated — the previous one was set aside' });
    } catch (err) { onError(err, 'Couldn’t regenerate the draft.'); } finally { setBusy(null); }
  }
  async function escalate(reason: string) {
    setBusy('escalate');
    try {
      const handover = await flagVoiceAnswer(d.question, text.trim() || d.reply, d.audience, reason || 'Escalated to a technician from Drafts & approvals.');
      const updated = await patchDraft(d.id, { action: 'reject' });
      onRejectReason(`Escalated to technician${reason ? `: ${reason}` : ''}`);
      onUpdated(updated);
      onCreated(handover);
      setMode(null);
      void refresh();
      toast({ tone: 'success', text: 'Escalated — a team-review draft was created' });
    } catch (err) { onError(err, 'Couldn’t escalate this draft.'); } finally { setBusy(null); }
  }

  return (
    <article className="dr-card">
      <header className="dr-card-h">
        <button type="button" className="c-btn sm ghost dr-back" onClick={onBack}><Icon name="chevron" size={14} className="flip" /> Drafts</button>
        <div className="c-row">
          <Pill tone="brand">{AUDIENCE_LABELS[d.audience]}</Pill>
          <span className="c-muted">via {CHANNEL_LABELS[d.channel]}</span>
          {d.recipient && <span className="c-muted">→ {canSeePii ? d.recipient : mask(d.recipient)}</span>}
          <span className="c-grow" />
          <span className="c-muted" title={fmtAbs(d.created_at)}>Drafted <RelTime t={d.created_at} /></span>
        </div>
        <h2 className="dr-q">{d.question}</h2>
      </header>

      {review && pending && (
        <div className="c-banner t-warning dr-review" role="status">
          <Icon name="alert" />
          <div>
            <strong>Human review required.</strong>{' '}
            {d.outcome === 'clarify' ? 'The agent needs more information before it can answer.' : d.outcome === 'handover' ? 'The agent recommends a technician handles this.' : 'The agent declined to answer from the knowledge base.'}
            {d.team_handover?.summary && <p>{d.team_handover.summary}</p>}
            {d.team_handover?.needed?.length ? <ul>{d.team_handover.needed.map((n) => <li key={n}>{n}</li>)}</ul> : null}
          </div>
        </div>
      )}

      <div className="dr-signals">
        <span className={`dr-signal t-${g.tone}`} title={g.detail}><Icon name="shield" size={14} /> {g.label}</span>
        {flags.map((f) => <Pill key={f} tone="danger" dot>{f}</Pill>)}
        {d.edited && <Pill tone="info">Edited</Pill>}
      </div>

      <div className="dr-reply">
        <div className="dr-reply-h">
          <span className="c-h3">Reply</span>
          {pending && canApprove && !editing && <button type="button" className="c-btn sm ghost" onClick={() => setEditing(true)}><Icon name="drafts" size={14} /> Edit</button>}
        </div>
        {editing ? (
          <>
            <label className="c-sr" htmlFor={`dr-edit-${d.id}`}>Edit reply</label>
            <textarea id={`dr-edit-${d.id}`} className="c-textarea dr-edit" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            <div className="c-row"><button type="button" className="c-btn sm primary" onClick={() => void saveEdit()}>Save edits</button><button type="button" className="c-btn sm ghost" onClick={() => { setText(d.reply); setEditing(false); }}>Cancel</button></div>
          </>
        ) : (
          <div className="dr-reply-body">{text}</div>
        )}
      </div>

      {d.outcome === 'clarify' && pending && canAsk && (
        <div className="dr-quick">
          <span className="c-h3">Add the missing detail and regenerate</span>
          <div className="c-chips">
            {QUICK_INFO.map((qi) => <button key={qi} type="button" className="c-chip" onClick={() => { setInfoLabel(qi); setNote(''); setMode('info'); }}>{qi}</button>)}
          </div>
          {mode === 'info' && (
            <form className="dr-inline" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void regenerate(`${infoLabel}: ${note.trim()}`); }}>
              <label htmlFor="dr-info">{infoLabel}</label>
              <input id="dr-info" className="c-input" value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder={infoLabel === 'Model number' ? 'e.g. SUN-10K-SG04LP3-AU' : ''} />
              <button type="submit" className="c-btn primary sm" disabled={!note.trim() || busy != null}>{busy === 'regen' ? 'Regenerating…' : 'Regenerate'}</button>
            </form>
          )}
        </div>
      )}

      {d.sources.length > 0 ? (
        <details className="dr-sources">
          <summary>Sources ({d.sources.length})</summary>
          <ul>{d.sources.map((s) => <li key={s.id}><Pill tone={s.kind === 'rule' ? 'brand' : 'neutral'}>{s.kind === 'rule' ? 'Verified rule' : 'Manufacturer'}</Pill><span>{s.title}</span><span className="c-muted">{s.source}</span></li>)}</ul>
        </details>
      ) : <p className="c-muted dr-nosrc">No sources cited.</p>}

      {d.note_for_ryan && <div className="dr-note"><b>Note from the agent</b>{d.note_for_ryan}</div>}

      {pending ? (
        <footer className="dr-actions">
          {mode === 'reject' || mode === 'escalate' ? (
            <form className="dr-inline" onSubmit={(e) => { e.preventDefault(); void (mode === 'reject' ? reject(note.trim()) : escalate(note.trim())); }}>
              <label htmlFor="dr-reason">{mode === 'reject' ? 'Reason for rejecting (optional)' : 'What should the technician check?'}</label>
              <input id="dr-reason" className="c-input" value={note} onChange={(e) => setNote(e.target.value)} autoFocus
                placeholder={mode === 'reject' ? 'e.g. Wrong model, out-of-date warranty terms' : 'e.g. Needs a site visit to check isolation fault'} />
              <button type="submit" className={`c-btn sm ${mode === 'reject' ? 'danger' : 'primary'}`} disabled={busy != null}>{mode === 'reject' ? 'Reject draft' : 'Escalate'}</button>
              <button type="button" className="c-btn sm ghost" onClick={() => setMode(null)}>Cancel</button>
            </form>
          ) : (
            <>
              {canApprove && (
                <button type="button" className="c-btn primary lg" disabled={busy != null || editing} onClick={() => void approve()}>
                  <Icon name="send" size={16} /> {busy === 'approve' ? 'Sending…' : d.outcome === 'handover' ? 'Send holding reply & hand to team' : 'Approve & send'}
                </button>
              )}
              {canAsk && <button type="button" className="c-btn" disabled={busy != null} onClick={() => void regenerate()}><Icon name="refresh" size={14} /> {busy === 'regen' ? 'Regenerating…' : 'Regenerate'}</button>}
              {canAsk && <button type="button" className="c-btn" disabled={busy != null} onClick={() => { setNote(''); setMode('escalate'); }}><Icon name="wrench" size={14} /> Escalate to technician</button>}
              {canApprove && <button type="button" className="c-btn danger" disabled={busy != null} onClick={() => { setNote(''); setMode('reject'); }}>Reject…</button>}
              {!canApprove && <span className="c-muted">Your role can’t approve drafts.</span>}
            </>
          )}
        </footer>
      ) : (
        <footer className="dr-done">
          <Pill tone={d.status === 'rejected' ? 'neutral' : 'success'} dot>
            {d.status === 'sent' ? (d.edited ? 'Approved with edits · sent' : 'Approved · sent') : d.status === 'team' ? 'Reply sent · with the team' : 'Rejected'}
          </Pill>
          {d.decided_at && <span className="c-muted"><RelTime t={d.decided_at} /></span>}
          {d.status === 'rejected' && rejectReason && <span className="c-muted">Reason: {rejectReason}</span>}
          {d.delivery && (
            <span className={`c-muted dr-deliv ${d.delivery.status}`}>
              {d.delivery.status === 'delivered' ? 'Delivered' : d.delivery.status === 'failed' ? 'Delivery failed' : 'Delivery skipped'} via {d.delivery.channel} — {d.delivery.detail}
            </span>
          )}
        </footer>
      )}
    </article>
  );
}

function Composer({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (d: Draft) => void; onError: (e: unknown, m: string) => void }) {
  const [audience, setAudience] = useState<Audience>('installer');
  const [channel, setChannel] = useState<Channel>('chat');
  const [recipient, setRecipient] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const examples = SUGGESTIONS.filter((s) => s.audience === audience).slice(0, 4);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    try { onCreated(await createDraft({ question: question.trim(), audience, channel, recipient: recipient.trim() || null })); }
    catch (err) { onError(err, 'The draft didn’t come through. Try again.'); }
    finally { setBusy(false); }
  }
  return (
    <Drawer open onClose={onClose} title="Draft a reply" sub="The agent drafts from TSBA’s knowledge base. You approve before anything is sent.">
      <form className="dr-compose" onSubmit={submit}>
        <fieldset>
          <legend>Who’s asking</legend>
          <div className="c-chips">{AUDIENCES.map((a) => <button key={a} type="button" className={`c-chip ${audience === a ? 'on' : ''}`} aria-pressed={audience === a} onClick={() => setAudience(a)}>{AUDIENCE_LABELS[a]}</button>)}</div>
        </fieldset>
        <fieldset>
          <legend>Arrived via (reply goes back the same way)</legend>
          <div className="c-chips">{CHANNELS.map((c) => <button key={c} type="button" className={`c-chip ${channel === c ? 'on' : ''}`} aria-pressed={channel === c} onClick={() => setChannel(c)}>{CHANNEL_LABELS[c]}</button>)}</div>
        </fieldset>
        <label className="p360-field"><span>Send approved reply to (optional)</span><input className="c-input" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="name@example.com or +61…" /></label>
        <label className="p360-field"><span>Their message</span><textarea className="c-textarea" value={question} onChange={(e) => setQuestion(e.target.value)} rows={5} autoFocus placeholder="What's the minimum clearance between a battery and a window?" /></label>
        {!question && examples.length > 0 && (
          <div><span className="c-h3">Examples</span><div className="c-chips">{examples.map((s) => <button key={s.question} type="button" className="c-chip" onClick={() => { setQuestion(s.question); setChannel(s.channel); }}>{s.question}</button>)}</div></div>
        )}
        <div className="c-row"><button type="submit" className="c-btn primary" disabled={busy || !question.trim()}>{busy ? 'Drafting…' : 'Draft reply'}</button><button type="button" className="c-btn ghost" onClick={onClose}>Cancel</button></div>
      </form>
    </Drawer>
  );
}
