// Today: replies first, then drafts ready to approve. Review: the approve screen.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KW_METRICS, KW_NOTE_LABELS } from '@tsba/shared';
import { AuthError, kw } from '../../api';
import { useConsole } from '../../lib/console';
import type { KwClient, KwMessage, KwProfile, KwQueueItem, KwSendResult, KwTextType, KwToday } from '../../lib/kw-types';
import { Icon, Menu } from '../../ui';
import { useAgent } from './Agent';
import { Ring, TYPE_LABEL, VoiceBox, cadenceLabel, errText, firstName, fmtDate, fmtWhen, smsCount } from './parts';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
}

export function useToday() {
  const { onAuthError } = useConsole();
  const [data, setData] = useState<KwToday | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<number | undefined>();
  const load = useCallback(async () => {
    try {
      const t = await kw.today();
      setData(t);
      setErr(null);
      window.clearTimeout(timer.current);
      // Drafts are written in the background; poll until they're all there.
      if (t.generating > 0) timer.current = window.setTimeout(load, 2500);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else setErr(errText(e));
    }
  }, [onAuthError]);
  useEffect(() => {
    void load();
    return () => window.clearTimeout(timer.current);
  }, [load]);
  return { data, err, reload: load };
}

function QueueCard({ item, onOpen }: { item: KwQueueItem; onOpen: () => void }) {
  const { client, message } = item;
  const tag = message.kind === 'reply' ? 'Replied' : message.kind === 'new' ? 'First text' : message.kind === 'adhoc' ? 'One-off' : TYPE_LABEL[message.type];
  return (
    <button type="button" className="kw-card kw-row-card" onClick={onOpen}>
      <Ring client={client} />
      <div className="kw-grow">
        <div className="kw-rowline">
          <span className="kw-name kw-clip">{client.name}</span>
          <span className={`kw-tag is-${message.kind === 'reply' ? 'reply' : message.type}`}>{tag}</span>
        </div>
        <div className="kw-small kw-clip">{message.body || 'Tap to write the text'}</div>
      </div>
      <Icon name="chevron" size={16} />
    </button>
  );
}

/** What the pipeline agent has queued up, as one tap-through card. */
function AgentTeaser({ onOpen }: { onOpen: () => void }) {
  const { data } = useAgent();
  if (!data) return null;
  const n = data.tasks.length;
  return (
    <button type="button" className="kw-card kw-row-card" onClick={onOpen}>
      <Icon name="ai" />
      <div className="kw-grow">
        <div className="kw-name">{n ? `Your agent has ${n} thing${n > 1 ? 's' : ''} for you` : 'Your agent: all clear'}</div>
        <div className="kw-small">{data.brief}</div>
      </div>
      <Icon name="chevron" size={16} />
    </button>
  );
}

export function Today({ profile, onReview, onAdd, onClient, onScore, onAgent }: {
  profile: KwProfile;
  onReview: (messageId: string) => void;
  onAdd: () => void;
  onClient: (id: string) => void;
  onScore: () => void;
  onAgent: () => void;
}) {
  const { toast } = useConsole();
  const { data, err, reload } = useToday();
  if (err) return <div className="kw-phone"><p className="kw-err">{err}</p><button type="button" className="kw-btn" onClick={reload}>Try again</button></div>;
  if (!data) return <div className="kw-phone"><div className="kw-think"><i />Getting your day ready…</div></div>;

  const total = data.replies.length + data.due.length;
  const first = data.replies[0] ?? data.due[0];
  const summary = [
    data.due.length ? `${data.due.length} follow-up${data.due.length > 1 ? 's' : ''} drafted and waiting.` : '',
    data.replies.length ? `${data.replies.length} client${data.replies.length > 1 ? 's' : ''} replied.` : '',
    total ? `About ${Math.max(1, total)} minute${total > 1 ? 's' : ''} of your day.` : 'Everyone due today has heard from you.',
  ].filter(Boolean).join(' ');

  return (
    <div className="kw-phone kw-enter">
      <div className="kw-hero">
        <div className="kw-small">{fmtDate(data.date, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <h2 className="kw-big">{greeting()}, {firstName(profile.displayName)}.</h2>
        <p className="kw-sub">{summary}</p>
        {data.generating > 0 && <div className="kw-think kw-inline"><i />Writing {data.generating} draft{data.generating > 1 ? 's' : ''} from your notes…</div>}
      </div>

      {first ? (
        <button type="button" className="kw-btn kw-wide" onClick={() => onReview(first.message.id)}>Start reviewing</button>
      ) : (
        <div className="kw-card kw-center">
          <div className="kw-name">Your pipeline is warm.</div>
          <p className="kw-small">Now go and meet someone new.</p>
          <button type="button" className="kw-btn kw-wide" onClick={onAdd}><Icon name="plus" size={16} /> Add a client</button>
        </div>
      )}

      <AgentTeaser onOpen={onAgent} />

      {data.agentHandling.length > 0 && (
        <>
          <h3 className="kw-sec">The agent is answering</h3>
          <div className="kw-list">
            {data.agentHandling.map((c) => (
              <div key={c.id} className="kw-card kw-row-card">
                <Ring client={c} />
                <button type="button" className="kw-grow kp-plain" onClick={() => onClient(c.id)}>
                  <div className="kw-name kw-clip">{c.name}</div>
                  <div className="kw-small kw-clip">{c.convoReason || 'Routine replies'}</div>
                </button>
                <button type="button" className="kw-tool" onClick={async () => {
                  try { await kw.takeOver(c.id); toast({ text: `You’re handling ${firstName(c.name)} now`, tone: 'success' }); void reload(); } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
                }}>Take over</button>
              </div>
            ))}
          </div>
        </>
      )}

      {data.replies.length > 0 && (
        <>
          <h3 className="kw-sec">Waiting on you</h3>
          <div className="kw-list">{data.replies.map((i) => <QueueCard key={i.message.id} item={i} onOpen={() => onReview(i.message.id)} />)}</div>
        </>
      )}
      {data.due.length > 0 && (
        <>
          <h3 className="kw-sec">Ready to send</h3>
          <div className="kw-list">{data.due.map((i) => <QueueCard key={i.message.id} item={i} onOpen={() => onReview(i.message.id)} />)}</div>
        </>
      )}
      {data.scheduled.length > 0 && (
        <>
          <h3 className="kw-sec">Approved, sending later</h3>
          <div className="kw-list">
            {data.scheduled.map((i) => (
              <div key={i.message.id} className="kw-card kw-row-card">
                <Ring client={i.client} />
                <div className="kw-grow">
                  <div className="kw-name kw-clip">{i.client.name}</div>
                  <div className="kw-small">Goes out {fmtWhen(i.message.scheduledFor)}</div>
                </div>
                <button type="button" className="kw-tool" onClick={async () => {
                  try {
                    await kw.unschedule(i.message.id);
                    toast({ text: 'Back in your drafts', tone: 'info' });
                    void reload();
                  } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
                }}>Undo</button>
              </div>
            ))}
          </div>
        </>
      )}
      {data.noRhythm.length > 0 && (
        <>
          <h3 className="kw-sec">No rhythm set</h3>
          <div className="kw-list">
            {data.noRhythm.map((c) => (
              <button key={c.id} type="button" className="kw-card kw-row-card" onClick={() => onClient(c.id)}>
                <Ring client={c} />
                <div className="kw-grow">
                  <div className="kw-name kw-clip">{c.name}</div>
                  <div className="kw-small">{c.daysSinceContact != null ? `Last heard from you ${c.daysSinceContact} days ago` : 'Not texted yet'}. They’ll drift.</div>
                </div>
                <span className="kw-tool">Set a rhythm</span>
              </button>
            ))}
          </div>
        </>
      )}

      <h3 className="kw-sec">Today’s numbers</h3>
      <button type="button" className="kw-card kw-mini" onClick={onScore}>
        {[KW_METRICS[0], KW_METRICS[1], KW_METRICS[2], KW_METRICS[6]].map((m) => (
          <div key={m.k}><b>{data.score[m.k]}</b><span>{m.label.replace(/ (made|had)$/, '')}</span></div>
        ))}
      </button>
    </div>
  );
}

// ─── Review & approve ────────────────────────────────────────────────────────
export function Review({ messageId, onBack, onNext, onClient }: {
  messageId: string;
  onBack: () => void;
  onNext: (messageId: string | null) => void;
  onClient: (id: string) => void;
}) {
  const { toast, onAuthError } = useConsole();
  const { data, reload } = useToday();
  const [msg, setMsg] = useState<KwMessage | null>(null);
  const [client, setClient] = useState<KwClient | null>(null);
  const [thread, setThread] = useState<KwMessage[]>([]);
  const [text, setText] = useState('');
  const [type, setType] = useState<KwTextType>('business');
  const [busy, setBusy] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [sent, setSent] = useState<KwSendResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const queue = useMemo(() => (data ? [...data.replies, ...data.due] : []), [data]);
  const pos = queue.findIndex((q) => q.message.id === messageId);

  // Typing in the reply box tells the server a human is here (takes over from the agent).
  const lastPing = useRef(0);
  const pingTyping = () => {
    if (!client || Date.now() - lastPing.current < 20_000) return;
    lastPing.current = Date.now();
    void kw.typing(client.id).catch(() => {});
  };

  // Load the draft + client context.
  useEffect(() => {
    let live = true;
    setSent(null);
    setErr(null);
    setPromptOpen(false);
    setInstruction('');
    (async () => {
      try {
        const t = data ?? (await kw.today());
        const item = [...t.replies, ...t.due].find((q) => q.message.id === messageId);
        const clientId = item?.client.id;
        if (!clientId) {
          if (live) setErr('This draft has already been dealt with.');
          return;
        }
        const detail = await kw.client(clientId);
        const m = detail.open.find((o) => o.id === messageId) ?? item!.message;
        if (!live) return;
        setMsg(m);
        setClient(detail.client);
        setThread(detail.thread);
        setText(m.body);
        setType(m.type);
        if (!m.body) setPromptOpen(true);
      } catch (e) {
        if (e instanceof AuthError) onAuthError();
        else if (live) setErr(errText(e));
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId]);

  const rewrite = async (body: { type?: KwTextType; instruction?: string; shorter?: boolean; another?: boolean }, label: string) => {
    if (!msg) return;
    setBusy(label);
    try {
      const m = await kw.rewrite(msg.id, { ...body, current: text });
      setMsg(m);
      setText(m.body);
      setType(m.type);
      if (body.instruction) { setInstruction(''); setPromptOpen(false); }
    } catch (e) {
      toast({ text: errText(e), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!msg) return;
    setBusy('send');
    try {
      const r = await kw.approve(msg.id, text, type);
      setSent(r);
      void reload();
      if (r.message.status === 'failed') toast({ text: r.note, tone: 'danger' });
    } catch (e) {
      toast({ text: errText(e), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy('act');
    try {
      await fn();
      toast({ text: done, tone: 'info' });
      const t = await kw.today();
      const next = [...t.replies, ...t.due].find((q) => q.message.id !== messageId);
      onNext(next?.message.id ?? null);
    } catch (e) {
      toast({ text: errText(e), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  if (err) {
    return (
      <div className="kw-phone">
        <div className="kw-bar"><button type="button" className="kw-iconbtn" aria-label="Back to today" onClick={onBack}><Icon name="back" /></button><span /><span /></div>
        <p className="kw-sub">{err}</p>
        <button type="button" className="kw-btn" onClick={onBack}>Back to today</button>
      </div>
    );
  }
  if (!msg || !client) return <div className="kw-phone"><div className="kw-think"><i />Opening the draft…</div></div>;

  if (sent) {
    const next = queue.find((q) => q.message.id !== messageId);
    const c = sent.client;
    const isSent = sent.message.status === 'sent';
    return (
      <div className="kw-phone kw-enter">
        <div className="kw-sent">
          <div className={`kw-tick ${isSent ? '' : 'is-later'}`}><Icon name={isSent ? 'check' : 'clock'} size={30} /></div>
          <h2 className="kw-big">{isSent ? `Sent to ${firstName(c.name)}` : sent.message.status === 'failed' ? 'Not sent' : `Approved for ${firstName(c.name)}`}</h2>
          <p className="kw-sub">{isSent ? `${fmtWhen(sent.message.sentAt)}, signed by you` : sent.note}</p>
        </div>
        <div className="kw-card kw-row-card">
          <Ring client={c} />
          <div className="kw-grow">
            {c.cadenceDays && c.nextDue ? (
              <>
                <div className="kw-name">Next: {TYPE_LABEL[c.mix === 'mix' ? c.nextType : c.mix === 'friendly' ? 'friendly' : 'business']}</div>
                <div className="kw-small">{fmtDate(c.nextDue, { weekday: 'long', day: 'numeric', month: 'long' })}. A draft will be waiting that morning.</div>
              </>
            ) : (
              <>
                <div className="kw-name">Back in your hands</div>
                <div className="kw-small">No rhythm set for {firstName(c.name)} yet.</div>
              </>
            )}
          </div>
        </div>
        {isSent && <p className="kw-small kw-center-text">Follow-ups today: {(data?.score.followups ?? 0)} of {KW_METRICS[6].day}. Counted for you on the scoreboard.</p>}
        <div className="kw-foot kw-foot-split">
          <button type="button" className="kw-btn kw-ghost" onClick={onBack}>Today</button>
          {next && <button type="button" className="kw-btn" onClick={() => onNext(next.message.id)}>Next: {firstName(next.client.name)}</button>}
        </div>
      </div>
    );
  }

  const f = firstName(client.name);
  const why = msg.kind === 'reply' ? `${f} replied. The rhythm is paused until you answer.`
    : msg.kind === 'new' ? 'First text after the visit, while it’s fresh.'
    : msg.kind === 'adhoc' ? `A one-off text. ${f}’s rhythm stays as it is.`
    : `${cadenceLabel(client.cadenceDays)} rhythm.${client.daysSinceContact != null ? ` You last texted ${client.daysSinceContact} days ago.` : ''}`;
  const used = new Set(msg.usedNotes);
  const lastTwo = thread.filter((m) => m.status === 'sent' || m.status === 'received').slice(-3);

  return (
    <div className="kw-phone kw-enter">
      <div className="kw-bar">
        <button type="button" className="kw-iconbtn" aria-label="Back to today" onClick={onBack}><Icon name="back" /></button>
        <div className="kw-bar-t">{pos >= 0 ? `${pos + 1} of ${queue.length} today` : 'New text'}</div>
        {msg.kind !== 'reply' ? (
          <Menu label="Later" trigger={<span className="kw-linkbtn">Later</span>} items={[
            { label: 'Snooze until tomorrow', icon: 'clock', onSelect: () => act(() => kw.snooze(msg.id, 1), 'Snoozed until tomorrow') },
            { label: 'Snooze 3 days', icon: 'clock', onSelect: () => act(() => kw.snooze(msg.id, 3), 'Snoozed 3 days') },
            { label: 'Snooze a week', icon: 'clock', onSelect: () => act(() => kw.snooze(msg.id, 7), 'Snoozed a week') },
            { label: 'Skip this one', icon: 'x', onSelect: () => act(() => kw.skip(msg.id), 'Skipped. The rhythm carries on.') },
          ]} />
        ) : <span />}
      </div>

      <div className="kw-rowline kw-client-head">
        <Ring client={client} size={52} />
        <div className="kw-grow">
          <h2 className="kw-h2">{client.name}</h2>
          <div className="kw-small">{client.stage || 'No stage yet'}</div>
        </div>
        <button type="button" className="kw-tool" onClick={() => onClient(client.id)}>Profile</button>
      </div>
      <p className="kw-why">{why}</p>

      {(msg.kind === 'reply' ? lastTwo : lastTwo.slice(-1)).length > 0 && (
        <div className="kw-thread">
          {(msg.kind === 'reply' ? lastTwo : lastTwo.slice(-1)).map((m) => (
            <div key={m.id} className={`kw-msg is-${m.direction}`}>{m.body}<small>{fmtWhen(m.sentAt ?? m.createdAt)}</small></div>
          ))}
        </div>
      )}

      {msg.kind !== 'reply' && (
        <div className="kw-seg" role="group" aria-label="Kind of text">
          {(['business', 'friendly'] as KwTextType[]).map((t) => (
            <button key={t} type="button" aria-pressed={type === t} disabled={!!busy}
              onClick={() => { if (t !== type) { setType(t); void rewrite({ type: t }, 'type'); } }}>{TYPE_LABEL[t]}</button>
          ))}
        </div>
      )}

      <div className={`kw-draft ${busy && busy !== 'send' && busy !== 'act' ? 'is-busy' : ''}`}>
        <textarea aria-label={`Text to ${f}`} value={text} rows={5} onChange={(e) => { setText(e.target.value); pingTyping(); }}
          placeholder="Tell it what to say below, or type the text yourself." />
        <div className="kw-draft-meta"><span>Tap the text to edit</span><span>{smsCount(text)}</span></div>
      </div>

      <div className="kw-tools">
        <button type="button" className="kw-tool" disabled={!!busy} onClick={() => rewrite({ another: true }, 'another')}><Icon name="refresh" size={15} /> Another version</button>
        <button type="button" className="kw-tool" disabled={!!busy} onClick={() => rewrite({ shorter: true }, 'shorter')}><Icon name="columns" size={15} /> Shorter</button>
        <button type="button" className={`kw-tool ${promptOpen ? 'is-on' : ''}`} onClick={() => setPromptOpen((o) => !o)}><Icon name="drafts" size={15} /> Tell it what to say</button>
      </div>

      {promptOpen && (
        <div className="kw-prompt">
          <VoiceBox label="What should the text say?" value={instruction} onChange={setInstruction} rows={2}
            placeholder={msg.kind === 'reply' ? 'e.g. offer a call about battery sizes' : `e.g. ask if ${f} wants to come by Saturday`} />
          <button type="button" className="kw-btn kw-small-btn" disabled={!instruction.trim() || !!busy} onClick={() => rewrite({ instruction }, 'prompt')}>
            <Icon name="ai" size={15} /> Write it
          </button>
        </div>
      )}

      {client.notes.length > 0 && (
        <details className="kw-used" open={used.size > 0}>
          <summary>{used.size ? `Uses ${used.size} of your notes` : 'Your notes on this client'}</summary>
          <ul>
            {client.notes.map((n) => (
              <li key={n.id} className={used.has(n.id) ? 'is-used' : ''}><span>{KW_NOTE_LABELS[n.cat]}</span>{n.text}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="kw-foot">
        <button type="button" className="kw-btn kw-wide" disabled={!text.trim() || !!busy} onClick={approve}>
          <Icon name="send" size={16} /> {busy === 'send' ? 'Sending…' : `Approve and send to ${f}`}
        </button>
      </div>
    </div>
  );
}
