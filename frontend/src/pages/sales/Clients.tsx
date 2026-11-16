// Clients: who's going cold at a glance, each client's memory + texts, and the
// add-a-client flow (contact → voice note → notes → rhythm), under a minute.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { KW_CADENCES, KW_NOTE_CATS, KW_NOTE_LABELS } from '@tsba/shared';
import { AuthError, kw } from '../../api';
import { useConsole } from '../../lib/console';
import type { KwActivity, KwAgentTask, KwClient, KwExtractResult, KwMessage, KwMix, KwNote, KwNoteCat, KwStatus } from '../../lib/kw-types';
import { Icon, Menu } from '../../ui';
import { ActivityFeed, TaskCard } from './Agent';
import { DealPanel } from './Deal';
import {
  MIX_LABEL, Ring, TYPE_LABEL, VoiceBox, WarmthTag, cadenceLabel, errText, firstName, fmtDate, fmtWhen, previewDates,
} from './parts';

type Filter = 'all' | 'attention' | 'paused' | 'none';

export function ClientList({ onOpen, onAdd }: { onOpen: (id: string) => void; onAdd: () => void }) {
  const { onAuthError } = useConsole();
  const [clients, setClients] = useState<KwClient[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    kw.clients().then((r) => setClients(r.clients)).catch((e) => (e instanceof AuthError ? onAuthError() : setErr(errText(e))));
  }, [onAuthError]);

  const rank = (c: KwClient) => ({ paused: 0, cold: 1, due: 2, cooling: 3, warm: 4, stopped: 5 })[c.warmth];
  const list = useMemo(() => {
    const all = [...(clients ?? [])].sort((a, b) => rank(a) - rank(b) || a.warmthPct - b.warmthPct || a.name.localeCompare(b.name));
    const needle = q.trim().toLowerCase();
    return all.filter((c) => {
      if (needle && !`${c.name} ${c.stage} ${c.phone}`.toLowerCase().includes(needle)) return false;
      if (filter === 'attention') return c.warmth === 'cold' || c.warmth === 'due' || c.warmth === 'paused';
      if (filter === 'paused') return c.warmth === 'paused';
      if (filter === 'none') return !c.cadenceDays && !c.optedOut;
      return true;
    });
  }, [clients, filter, q]);

  const count = (f: Filter) => (clients ?? []).filter((c) =>
    f === 'attention' ? ['cold', 'due', 'paused'].includes(c.warmth) : f === 'paused' ? c.warmth === 'paused' : f === 'none' ? !c.cadenceDays && !c.optedOut : true).length;

  if (err) return <div className="kw-phone"><p className="kw-err">{err}</p></div>;
  if (!clients) return <div className="kw-phone"><div className="kw-think"><i />Loading clients…</div></div>;

  return (
    <div className="kw-phone kw-enter">
      <div className="kw-rowline">
        <h2 className="kw-big kw-grow">Clients</h2>
        <button type="button" className="kw-btn kw-small-btn" onClick={onAdd}><Icon name="plus" size={15} /> Add</button>
      </div>
      <p className="kw-sub">The ring is full right after you’ve been in touch and drains as their next text gets closer. Empty means due.</p>
      <input className="kw-input" type="search" placeholder="Search clients" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search clients" />
      <div className="kw-chips" role="group" aria-label="Filter clients">
        {([['all', 'All'], ['attention', 'Need attention'], ['paused', 'Mid-conversation'], ['none', 'No rhythm']] as [Filter, string][]).map(([f, l]) => (
          <button key={f} type="button" className="kw-chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>{l} <span>{count(f)}</span></button>
        ))}
      </div>
      {list.length === 0 ? (
        <div className="kw-card kw-center">
          <div className="kw-name">{clients.length ? 'Nobody here.' : 'No clients yet.'}</div>
          <p className="kw-small">{clients.length ? 'Everyone in this group is fine.' : 'Add someone straight after your next meeting.'}</p>
        </div>
      ) : (
        <div className="kw-list">
          {list.map((c) => (
            <button key={c.id} type="button" className="kw-card kw-row-card" onClick={() => onOpen(c.id)}>
              <Ring client={c} />
              <div className="kw-grow">
                <div className="kw-rowline"><span className="kw-name kw-clip">{c.name}</span><WarmthTag warmth={c.warmth} /></div>
                <div className="kw-small kw-clip">
                  {c.stage ? `${c.stage} · ` : ''}
                  {c.optedOut ? 'Never texted again' : c.cadenceDays ? `${cadenceLabel(c.cadenceDays)}, next ${fmtDate(c.nextDue)}` : 'No rhythm set'}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Client profile ─────────────────────────────────────────────────────────
export function ClientDetail({ id, status, onBack, onReview, onDeleted }: {
  id: string;
  status: KwStatus;
  onBack: () => void;
  onReview: (messageId: string) => void;
  onDeleted: () => void;
}) {
  const { toast, onAuthError } = useConsole();
  const [client, setClient] = useState<KwClient | null>(null);
  const [thread, setThread] = useState<KwMessage[]>([]);
  const [open, setOpen] = useState<KwMessage[]>([]);
  const [mode, setMode] = useState<'view' | 'note' | 'rhythm' | 'edit' | 'simulate'>('view');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agentKey, setAgentKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const d = await kw.client(id);
      setClient(d.client);
      setThread(d.thread);
      setOpen(d.open);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else setErr(errText(e));
    }
  }, [id, onAuthError]);
  useEffect(() => { void load(); }, [load]);

  if (err) return <div className="kw-phone"><p className="kw-err">{err}</p><button type="button" className="kw-btn" onClick={onBack}>Back</button></div>;
  if (!client) return <div className="kw-phone"><div className="kw-think"><i />Loading…</div></div>;

  const removeNote = async (noteId: string) => {
    try {
      setClient(await kw.updateClient(client.id, { notes: client.notes.filter((n) => n.id !== noteId) }));
    } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
  };

  const textNow = async () => {
    setBusy(true);
    try {
      const m = await kw.compose(client.id);
      onReview(m.id);
    } catch (e) {
      toast({ text: errText(e), tone: 'danger' });
    } finally { setBusy(false); }
  };

  if (mode === 'note') {
    return <NoteStep client={client} title={`Add to what you know about ${firstName(client.name)}`} onBack={() => setMode('view')}
      onSaved={(c) => { setClient(c); setMode('view'); toast({ text: 'Notes saved', tone: 'success' }); }} />;
  }
  if (mode === 'rhythm') {
    return <RhythmStep client={client} onBack={() => setMode('view')} offerFirstText={false}
      onSaved={(c) => { setClient(c); setMode('view'); toast({ text: c.cadenceDays ? 'Rhythm set' : 'Rhythm cleared', tone: 'success' }); }} />;
  }
  if (mode === 'edit') {
    return <ContactStep initial={client} onBack={() => setMode('view')} onSaved={(c) => { setClient(c); setMode('view'); }} />;
  }

  const draft = open.find((m) => m.status === 'draft');
  const grouped = KW_NOTE_CATS.map((cat) => ({ cat, notes: client.notes.filter((n) => n.cat === cat) })).filter((g) => g.notes.length);

  return (
    <div className="kw-phone kw-enter">
      <div className="kw-bar">
        <button type="button" className="kw-iconbtn" aria-label="Back" onClick={onBack}><Icon name="back" /></button>
        <span />
        <Menu label="Client actions" items={[
          { label: 'Edit contact', icon: 'user', onSelect: () => setMode('edit') },
          ...(status.sms.mode === 'outbox' && !client.optedOut ? [{ label: 'Test: act out a client reply', icon: 'chat' as const, onSelect: () => setMode('simulate') }] : []),
          'sep',
          { label: 'Delete client', icon: 'x', danger: true, onSelect: async () => {
            if (!window.confirm(`Delete ${client.name} and every note and text? This can’t be undone.`)) return;
            try { await kw.deleteClient(client.id); toast({ text: 'Client deleted', tone: 'info' }); onDeleted(); } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
          } },
        ]} />
      </div>

      <div className="kw-rowline kw-client-head">
        <Ring client={client} size={60} />
        <div className="kw-grow">
          <h2 className="kw-h2">{client.name}</h2>
          <div className="kw-small">{[client.stage, client.phone].filter(Boolean).join(' · ') || 'No number yet'}</div>
          <WarmthTag warmth={client.warmth} />
        </div>
      </div>

      {client.optedOut && (
        <div className="kw-banner is-stop"><Icon name="shield" size={16} /> {firstName(client.name)} asked to stop. They will never get another text from this system.</div>
      )}
      {!client.phone && !client.optedOut && (
        <div className="kw-banner"><Icon name="alert" size={16} /> No mobile number, so no texts can go out. <button type="button" className="kw-linkbtn" onClick={() => setMode('edit')}>Add one</button></div>
      )}

      {status.autoReply && !client.optedOut && <ConvoBar client={client} onChanged={(c) => { setClient(c); void load(); setAgentKey((k) => k + 1); }} />}

      {mode === 'simulate' && <SimulateReply client={client} onDone={() => { setMode('view'); void load(); }} />}

      {!client.optedOut && (
        <div className="kw-tools">
          {draft ? (
            <button type="button" className="kw-btn kw-small-btn" onClick={() => onReview(draft.id)}><Icon name="drafts" size={15} /> Review waiting draft</button>
          ) : (
            <button type="button" className="kw-btn kw-small-btn" disabled={busy || !client.phone} onClick={textNow}><Icon name="chat" size={15} /> {client.paused ? 'Answer their reply' : 'Text now'}</button>
          )}
          <button type="button" className="kw-tool" onClick={() => setMode('note')}><Icon name="voice" size={15} /> Add a voice note</button>
        </div>
      )}

      <h3 className="kw-sec">Deal</h3>
      <DealPanel client={client} onSaved={(c) => { setClient(c); setAgentKey((k) => k + 1); }} />
      <ClientAgent key={agentKey} clientId={client.id} onReview={onReview} onChanged={load} />

      <h3 className="kw-sec">Rhythm</h3>
      <button type="button" className="kw-card kw-row-card" onClick={() => setMode('rhythm')} disabled={client.optedOut}>
        <Icon name="clock" />
        <div className="kw-grow">
          {client.cadenceDays ? (
            <>
              <div className="kw-name">{cadenceLabel(client.cadenceDays)} · {MIX_LABEL[client.mix]}</div>
              <div className="kw-small">
                {client.paused ? 'Paused while you’re talking. Restarts when you answer.' : `Next: ${TYPE_LABEL[client.mix === 'mix' ? client.nextType : client.mix === 'friendly' ? 'friendly' : 'business'].toLowerCase()} on ${fmtDate(client.nextDue)}`}
              </div>
            </>
          ) : (
            <>
              <div className="kw-name">No rhythm set</div>
              <div className="kw-small">{firstName(client.name)} will drift. Tap to set one.</div>
            </>
          )}
        </div>
        <Icon name="chevron" size={16} />
      </button>

      <h3 className="kw-sec">What you know</h3>
      {grouped.length === 0 ? (
        <p className="kw-small">Nothing yet. Add a voice note about your last chat.</p>
      ) : (
        <div className="kw-card kw-notes">
          {grouped.map((g) => (
            <div key={g.cat}>
              <b>{KW_NOTE_LABELS[g.cat]}</b>
              <ul>
                {g.notes.map((n) => (
                  <li key={n.id}>{n.text}<button type="button" className="kw-x" aria-label={`Remove note: ${n.text}`} onClick={() => removeNote(n.id)}><Icon name="x" size={13} /></button></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <h3 className="kw-sec">Texts</h3>
      {thread.length === 0 ? (
        <p className="kw-small">No texts yet.</p>
      ) : (
        <div className="kw-thread">
          {thread.map((m) => (
            <div key={m.id} className={`kw-msg is-${m.direction} ${m.status !== 'sent' && m.status !== 'received' ? `is-${m.status}` : ''}`}>
              {m.body}
              <small>
                {m.sentBy === 'agent' && <b className="kp-by-agent">Agent · </b>}
                {m.status === 'scheduled' ? `Goes out ${fmtWhen(m.scheduledFor)}` : m.status === 'held' ? `Held: ${m.error ?? 'they replied first'}` : m.status === 'failed' ? `Failed: ${m.error ?? ''}` : fmtWhen(m.sentAt ?? m.createdAt)}
              </small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SimulateReply({ client, onDone }: { client: KwClient; onDone: () => void }) {
  const { toast } = useConsole();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="kw-card kw-sim">
      <div className="kw-name">Act out a reply from {firstName(client.name)}</div>
      <p className="kw-small">Texts aren’t really being sent yet, so this stands in for their phone. Try “STOP” to test opt-outs.</p>
      <input className="kw-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Thanks, can you resend the quote?" aria-label="Client's reply" />
      <div className="kw-tools">
        <button type="button" className="kw-btn kw-small-btn" disabled={!text.trim() || busy} onClick={async () => {
          setBusy(true);
          try { await kw.simulateReply(client.id, text); toast({ text: 'Reply received. Rhythm paused, answer drafted.', tone: 'success' }); onDone(); }
          catch (e) { toast({ text: errText(e), tone: 'danger' }); }
          finally { setBusy(false); }
        }}>Receive reply</button>
        <button type="button" className="kw-tool" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Add a client ────────────────────────────────────────────────────────────
interface PickedContact { name: string; phone: string; email: string }

async function pickFromPhone(): Promise<PickedContact | null> {
  const nav = navigator as unknown as { contacts?: { select: (props: string[], opts: { multiple: boolean }) => Promise<{ name?: string[]; tel?: string[]; email?: string[] }[]> } };
  if (!nav.contacts?.select) return null;
  const [c] = await nav.contacts.select(['name', 'tel', 'email'], { multiple: false });
  if (!c) return null;
  return { name: c.name?.[0] ?? '', phone: c.tel?.[0] ?? '', email: c.email?.[0] ?? '' };
}
const contactPickerSupported = () => 'contacts' in navigator && 'ContactsManager' in window;

function ContactStep({ initial, onBack, onSaved }: { initial?: KwClient; onBack: () => void; onSaved: (c: KwClient) => void }) {
  const { toast } = useConsole();
  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [stage, setStage] = useState(initial?.stage ?? '');
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    try {
      const c = await pickFromPhone();
      if (c) { setName(c.name); setPhone(c.phone); setEmail(c.email); }
    } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
  };
  const save = async () => {
    setBusy(true);
    try {
      onSaved(initial ? await kw.updateClient(initial.id, { name, phone, email, stage }) : await kw.addClient({ name, phone, email, stage }));
    } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
    finally { setBusy(false); }
  };

  return (
    <div className="kw-phone kw-enter">
      <div className="kw-bar">
        <button type="button" className="kw-iconbtn" aria-label="Back" onClick={onBack}><Icon name="back" /></button>
        {!initial ? <div className="kw-steps"><i className="on" /><i /><i /></div> : <div className="kw-bar-t">Edit contact</div>}
        <span />
      </div>
      <h2 className="kw-big">{initial ? 'Contact details' : 'Who did you just meet?'}</h2>
      {!initial && contactPickerSupported() && (
        <button type="button" className="kw-btn kw-wide kw-ghost" onClick={pick}><Icon name="user" size={16} /> Choose from phone contacts</button>
      )}
      <label className="kw-label" htmlFor="kw-cn">Name</label>
      <input id="kw-cn" className="kw-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      <label className="kw-label" htmlFor="kw-cp">Mobile</label>
      <input id="kw-cp" className="kw-input" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="04xx xxx xxx" />
      <label className="kw-label" htmlFor="kw-ce">Email <span className="kw-opt">optional</span></label>
      <input id="kw-ce" className="kw-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label className="kw-label" htmlFor="kw-cs">Where things are at <span className="kw-opt">optional</span></label>
      <input id="kw-cs" className="kw-input" value={stage} onChange={(e) => setStage(e.target.value)} placeholder="Site visit done, Quote sent…" list="kw-stages" />
      <datalist id="kw-stages">
        {['Site visit done', 'Quote sent', 'Proposal sent', 'Waiting on approval', 'Customer', 'Builder partner'].map((s) => <option key={s} value={s} />)}
      </datalist>
      <div className="kw-foot">
        <button type="button" className="kw-btn kw-wide" disabled={!name.trim() || busy} onClick={save}>{initial ? 'Save' : 'Next: what did you talk about?'}</button>
      </div>
    </div>
  );
}

function NoteStep({ client, title, onBack, onSaved, onSuggestion, step }: {
  client: KwClient; title: string; onBack: () => void; onSaved: (c: KwClient) => void;
  onSuggestion?: (s: KwExtractResult['suggestion']) => void; step?: number;
}) {
  const { toast } = useConsole();
  const [transcript, setTranscript] = useState('');
  const [result, setResult] = useState<KwExtractResult | null>(null);
  const [notes, setNotes] = useState<{ cat: KwNoteCat; text: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const sort = async () => {
    setBusy(true);
    try {
      const r = await kw.understandNote(client.id, transcript);
      setResult(r);
      setNotes(r.notes);
    } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const merged: Partial<KwNote>[] = [...client.notes, ...notes];
      const c = await kw.updateClient(client.id, { notes: merged, transcript, stage: !client.stage && result?.stage ? result.stage : undefined });
      if (result) onSuggestion?.(result.suggestion);
      onSaved(c);
    } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
    finally { setBusy(false); }
  };

  return (
    <div className="kw-phone kw-enter">
      <div className="kw-bar">
        <button type="button" className="kw-iconbtn" aria-label="Back" onClick={result ? () => setResult(null) : onBack}><Icon name="back" /></button>
        {step ? <div className="kw-steps"><i className="on" /><i className="on" /><i /></div> : <span />}
        {step ? <button type="button" className="kw-linkbtn" onClick={() => onSaved(client)}>Skip</button> : <span />}
      </div>
      {!result ? (
        <>
          <h2 className="kw-big">{title}</h2>
          <p className="kw-sub">Talk the way you’d tell a mate: the deal, the family, what decides it, what you promised. No form to fill in.</p>
          <VoiceBox label="Voice note" value={transcript} onChange={setTranscript} rows={8} autoFocus
            placeholder={`Just finished the site visit with ${firstName(client.name)}…`} />
          <div className="kw-foot">
            <button type="button" className="kw-btn kw-wide" disabled={transcript.trim().length < 5 || busy} onClick={sort}>
              {busy ? 'Sorting your notes…' : 'Sort my notes'}
            </button>
          </div>
        </>
      ) : (
        <>
          <h2 className="kw-big">Here’s what I’ll remember.</h2>
          <p className="kw-sub">Remove anything I got wrong. Personal details stay: they’re what make a friendly check-in feel human.</p>
          <div className="kw-card kw-notes">
            {KW_NOTE_CATS.map((cat) => {
              const items = notes.map((n, i) => ({ ...n, i })).filter((n) => n.cat === cat);
              if (!items.length) return null;
              return (
                <div key={cat}>
                  <b>{KW_NOTE_LABELS[cat]}</b>
                  <ul>
                    {items.map((n) => (
                      <li key={n.i}>
                        <input className="kw-note-in" value={n.text} aria-label={`${KW_NOTE_LABELS[cat]} note`}
                          onChange={(e) => setNotes(notes.map((x, j) => (j === n.i ? { ...x, text: e.target.value } : x)))} />
                        <button type="button" className="kw-x" aria-label={`Remove note: ${n.text}`} onClick={() => setNotes(notes.filter((_, j) => j !== n.i))}><Icon name="x" size={13} /></button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {notes.length === 0 && <p className="kw-small">No notes left.</p>}
          </div>
          <div className="kw-foot">
            <button type="button" className="kw-btn kw-wide" disabled={busy} onClick={save}>{step ? 'Looks right. Next: rhythm' : 'Save notes'}</button>
          </div>
        </>
      )}
    </div>
  );
}

function RhythmStep({ client, suggestion, onBack, onSaved, offerFirstText, step }: {
  client: KwClient; suggestion?: KwExtractResult['suggestion'] | null; onBack: () => void; onSaved: (c: KwClient) => void;
  offerFirstText: boolean; step?: number;
}) {
  const { toast } = useConsole();
  const preset = KW_CADENCES.some((c) => c.days === (client.cadenceDays ?? suggestion?.cadenceDays));
  const [cadence, setCadence] = useState<number | null>(client.cadenceDays ?? suggestion?.cadenceDays ?? null);
  const [custom, setCustom] = useState(!preset && !!client.cadenceDays);
  const [mix, setMix] = useState<KwMix | null>(client.cadenceDays ? client.mix : suggestion?.mix ?? null);
  const [time, setTime] = useState(client.sendTime ?? '');
  const [firstText, setFirstText] = useState(offerFirstText && !!client.phone);
  const [busy, setBusy] = useState(false);

  const dates = cadence && mix ? previewDates(cadence, mix) : [];
  const save = async (clear = false) => {
    setBusy(true);
    try {
      const c = await kw.updateClient(client.id, clear
        ? { cadenceDays: null }
        : { cadenceDays: cadence, mix: mix ?? 'business', sendTime: time || null, firstText, resume: false });
      onSaved(c);
    } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
    finally { setBusy(false); }
  };

  return (
    <div className="kw-phone kw-enter">
      <div className="kw-bar">
        <button type="button" className="kw-iconbtn" aria-label="Back" onClick={onBack}><Icon name="back" /></button>
        {step ? <div className="kw-steps"><i className="on" /><i className="on" /><i className="on" /></div> : <div className="kw-bar-t">Rhythm</div>}
        <span />
      </div>

      <div className="kw-ask">
        <p className="kw-q">How often should you hear from {firstName(client.name)}?</p>
        {suggestion && <p className="kw-why"><Icon name="ai" size={14} /> {suggestion.why}</p>}
        <div className="kw-chips">
          {KW_CADENCES.map((c) => (
            <button key={c.days} type="button" className="kw-chip" aria-pressed={!custom && cadence === c.days} onClick={() => { setCustom(false); setCadence(c.days); }}>
              {c.label}{suggestion?.cadenceDays === c.days ? ' ★' : ''}
            </button>
          ))}
          <button type="button" className="kw-chip" aria-pressed={custom} onClick={() => setCustom(true)}>Custom</button>
        </div>
        {custom && (
          <label className="kw-inline-field">Every <input type="number" min={2} max={365} className="kw-input kw-num" value={cadence ?? ''} onChange={(e) => setCadence(Number(e.target.value) || null)} /> days</label>
        )}
      </div>

      {cadence && (
        <div className="kw-ask kw-enter">
          <p className="kw-q">Is it business, or just a friendly check-in?</p>
          <div className="kw-list">
            {([['business', 'Business follow-ups', 'Moves the deal along: the quote, the next step.'],
               ['friendly', 'Friendly check-ins', 'Never sells. Just shows you remember them.'],
               ['mix', 'A mix of both', 'Alternates, so it never feels like chasing.']] as [KwMix, string, string][]).map(([m, l, d]) => (
              <button key={m} type="button" className={`kw-card kw-choice ${mix === m ? 'is-on' : ''}`} aria-pressed={mix === m} onClick={() => setMix(m)}>
                <div className="kw-name">{l}{suggestion?.mix === m ? ' ★' : ''}</div>
                <div className="kw-small">{d}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {cadence && mix && (
        <div className="kw-ask kw-enter">
          <p className="kw-q">Any particular time? <span className="kw-opt">optional</span></p>
          <input type="time" className="kw-input kw-time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Send time" />
          <h3 className="kw-sec">The next few texts</h3>
          <ul className="kw-dates">
            {dates.map((d) => <li key={d.date}><span>{fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'long' })}</span><em className={`kw-tag is-${d.type}`}>{TYPE_LABEL[d.type]}</em></li>)}
          </ul>
          <p className="kw-small">It keeps going until you change it. A draft waits for you each time. Nothing sends without you.</p>
          {offerFirstText && client.phone && (
            <label className="kw-check"><input type="checkbox" checked={firstText} onChange={(e) => setFirstText(e.target.checked)} /> Draft a thank-you text for today, while it’s fresh</label>
          )}
        </div>
      )}

      <div className="kw-foot">
        <button type="button" className="kw-btn kw-wide" disabled={!cadence || !mix || busy} onClick={() => save()}>{busy ? 'Saving…' : 'Set this rhythm'}</button>
        {client.cadenceDays && <button type="button" className="kw-linkbtn" onClick={() => save(true)}>Clear the rhythm</button>}
      </div>
    </div>
  );
}

export function AddClient({ onCancel, onDone }: { onCancel: () => void; onDone: (clientId: string) => void }) {
  const { toast } = useConsole();
  const [client, setClient] = useState<KwClient | null>(null);
  const [step, setStep] = useState<'contact' | 'note' | 'rhythm'>('contact');
  const [suggestion, setSuggestion] = useState<KwExtractResult['suggestion'] | null>(null);

  if (step === 'contact' || !client) {
    // Going back after the client exists edits it rather than adding a duplicate.
    return <ContactStep initial={client ?? undefined} onBack={client ? () => setStep('note') : onCancel} onSaved={(c) => {
      if (!client) toast({ text: `${firstName(c.name)} added. Counted as a pipeline addition.`, tone: 'success' });
      setClient(c);
      setStep('note');
    }} />;
  }
  if (step === 'note') {
    return <NoteStep client={client} step={2} title={`What did you and ${firstName(client.name)} talk about?`} onBack={() => setStep('contact')}
      onSuggestion={setSuggestion} onSaved={(c) => { setClient(c); setStep('rhythm'); }} />;
  }
  return <RhythmStep client={client} step={3} suggestion={suggestion} offerFirstText onBack={() => setStep('note')}
    onSaved={(c) => { toast({ text: `${firstName(c.name)} is set. You’ll never need to remember.`, tone: 'success' }); onDone(c.id); }} />;
}

/** The agent's open suggestions for this one client, and the deal's history. */
function ClientAgent({ clientId, onReview, onChanged }: { clientId: string; onReview: (id: string) => void; onChanged: () => void }) {
  const [data, setData] = useState<{ activity: KwActivity[]; tasks: KwAgentTask[] } | null>(null);
  const [all, setAll] = useState(false);
  const load = useCallback(() => { kw.clientActivity(clientId).then(setData).catch(() => setData({ activity: [], tasks: [] })); }, [clientId]);
  useEffect(load, [load]);
  if (!data) return null;
  const refresh = () => { load(); onChanged(); };
  return (
    <>
      {data.tasks.length > 0 && (
        <div className="kp-tasks">{data.tasks.map((t) => <TaskCard key={t.id} task={t} compact onDone={refresh} onReview={onReview} />)}</div>
      )}
      {data.activity.length > 0 && (
        <details className="kw-card" open={all} onToggle={(e) => setAll((e.target as HTMLDetailsElement).open)}>
          <summary className="kw-small" style={{ cursor: 'pointer' }}>History · {data.activity.length} event{data.activity.length > 1 ? 's' : ''}</summary>
          <ActivityFeed items={data.activity} onUndone={refresh} />
        </details>
      )}
    </>
  );
}

/** Who is answering this client: the agent or the rep. One tap to switch. */
function ConvoBar({ client, onChanged }: { client: KwClient; onChanged: (c: KwClient) => void }) {
  const { toast } = useConsole();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const f = firstName(client.name);
  const run = async (fn: () => Promise<KwClient>, msg: string) => {
    setBusy(true);
    try { onChanged(await fn()); toast({ text: msg, tone: 'success' }); } catch (e) { toast({ text: errText(e), tone: 'danger' }); } finally { setBusy(false); }
  };
  if (client.convo === 'agent') {
    return (
      <div className="kp-convo is-agent">
        <Icon name="ai" size={18} />
        <div className="kw-grow">
          <div className="kw-name">The agent is answering {f}</div>
          <div className="kw-small">{client.convoReason || 'Routine replies only.'} Anything about price, complaints or a call comes to you.</div>
        </div>
        <button type="button" className="kw-btn kw-small-btn" disabled={busy} onClick={() => run(() => kw.takeOver(client.id), 'You’re handling this now. The agent stopped.')}>Take over</button>
      </div>
    );
  }
  if (client.convo === 'rep') {
    return (
      <div className="kp-convo is-rep">
        <Icon name="user" size={18} />
        <div className="kw-grow">
          <div className="kw-name">You’re handling this conversation</div>
          <div className="kw-small">{client.convoReason ? `${client.convoReason}. ` : ''}The agent only drafts until you hand it back.</div>
          {!client.paused && (
            <input className="kw-input kp-reason" placeholder="Outcome to remember (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Outcome to remember" />
          )}
        </div>
        <button type="button" className="kw-tool" disabled={busy || client.paused} title={client.paused ? `${f} is waiting on your answer` : undefined}
          onClick={() => run(async () => (await kw.handBack(client.id, note)).client, 'Handed back. Summary saved to notes.')}>Done, hand back</button>
      </div>
    );
  }
  return null;
}
