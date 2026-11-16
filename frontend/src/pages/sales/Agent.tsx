// The pipeline agent's screen. Top: what it needs from the rep, one card per
// decision with the action built in. Bottom: everything it (and the rep) did,
// with an undo on the agent's own changes. The agent never sends a text; a
// "nudge" opens the normal review screen with a draft.
import { useCallback, useEffect, useState } from 'react';
import { kwStageLabel } from '@tsba/shared';
import { AuthError, kw } from '../../api';
import { useConsole } from '../../lib/console';
import type { KwActivity, KwAgentState, KwAgentTask, KwStage, KwStatus, KwTaskKind } from '../../lib/kw-types';
import { Icon, type IconName } from '../../ui';
import { errText, firstName, fmtWhen } from './parts';
import './pipeline.css';

const KIND_ICON: Record<KwTaskKind, IconName> = {
  move_stage: 'columns', chase: 'chat', call: 'voice', log_outcome: 'check', set_rhythm: 'clock', add_value: 'trend', close_lost: 'x', handback: 'send',
};
const KIND_LABEL: Record<KwTaskKind, string> = {
  move_stage: 'Stage change', chase: 'Gone quiet', call: 'New lead', log_outcome: 'After the visit', set_rhythm: 'No rhythm', add_value: 'Forecast', close_lost: 'Close out', handback: 'Conversation',
};

function ago(iso: string | null): string {
  if (!iso) return 'not yet';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return fmtWhen(iso);
}

export function useAgent() {
  const { onAuthError } = useConsole();
  const [data, setData] = useState<KwAgentState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(async (run = false) => {
    try {
      setData(await (run ? kw.runAgent() : kw.agent()));
      setErr(null);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else setErr(errText(e));
    }
  }, [onAuthError]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, err, reload };
}

/** One decision the agent needs. Buttons do the whole job; no extra screens. */
export function TaskCard({ task, onDone, onReview, onClient, compact }: {
  task: KwAgentTask;
  onDone: () => void;
  onReview: (messageId: string) => void;
  onClient?: (id: string) => void;
  compact?: boolean;
}) {
  const { toast } = useConsole();
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [quoted, setQuoted] = useState(false);
  const f = firstName(task.clientName);

  const act = async (body: Parameters<typeof kw.acceptTask>[1] = {}) => {
    setBusy(true);
    try {
      const r = await kw.acceptTask(task.id, body);
      if (r.messageId) { onReview(r.messageId); return; }
      toast({ text: r.note, tone: 'success' });
      onDone();
    } catch (e) {
      toast({ text: errText(e), tone: 'danger' });
    } finally { setBusy(false); }
  };
  const later = async (days = 7) => {
    setBusy(true);
    try {
      await kw.dismissTask(task.id, days);
      toast({ text: `OK. I won’t raise that for ${days} days.`, tone: 'info' });
      onDone();
    } catch (e) { toast({ text: errText(e), tone: 'danger' }); } finally { setBusy(false); }
  };
  const notNow = <button type="button" className="kw-tool" disabled={busy} onClick={() => later(task.kind === 'chase' ? 3 : 7)}>Not now</button>;
  const money = Number(value.replace(/[^\d.]/g, ''));

  let actions;
  switch (task.kind) {
    case 'move_stage':
      actions = <><button type="button" className="kw-btn kw-small-btn" disabled={busy} onClick={() => act()}>Move to {kwStageLabel(task.payload.toStage as KwStage)}</button>{notNow}</>;
      break;
    case 'close_lost':
      actions = (
        <>
          <input className="kw-input kp-reason" placeholder="Why? (optional)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label={`Why ${f} was lost`} />
          <button type="button" className="kw-btn kw-small-btn kp-danger" disabled={busy} onClick={() => act({ lostReason: reason })}>Close as lost</button>
          <button type="button" className="kw-tool" disabled={busy} onClick={() => later(30)}>Keep it open</button>
        </>
      );
      break;
    case 'chase':
      actions = <><button type="button" className="kw-btn kw-small-btn" disabled={busy} onClick={() => act()}><Icon name="ai" size={15} /> {busy ? 'Drafting…' : 'Draft a nudge'}</button>{notNow}</>;
      break;
    case 'call':
      actions = (
        <>
          <button type="button" className="kw-btn kw-small-btn" disabled={busy} onClick={() => act({ outcome: 'spoke' })}>Called, we spoke</button>
          <button type="button" className="kw-tool" disabled={busy} onClick={() => act({ outcome: 'no_answer' })}>No answer</button>
          {notNow}
        </>
      );
      break;
    case 'log_outcome':
      actions = quoted ? (
        <>
          <input className="kw-input kp-money" inputMode="decimal" placeholder="Quote $ (optional)" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Quote value" autoFocus />
          <button type="button" className="kw-btn kw-small-btn" disabled={busy} onClick={() => act({ toStage: 'quoted', value: money || undefined })}>Save</button>
          <button type="button" className="kw-tool" disabled={busy} onClick={() => setQuoted(false)}>Back</button>
        </>
      ) : (
        <>
          <button type="button" className="kw-btn kw-small-btn" disabled={busy} onClick={() => setQuoted(true)}>Quote sent</button>
          <button type="button" className="kw-tool" disabled={busy} onClick={() => act({ toStage: 'negotiating' })}>They’re deciding</button>
          <button type="button" className="kw-tool" disabled={busy} onClick={() => act({ toStage: 'lost' })}>Not going ahead</button>
          <button type="button" className="kw-tool" disabled={busy} onClick={() => act({ toStage: 'meeting', attended: false })}>Didn’t happen</button>
        </>
      );
      break;
    case 'set_rhythm':
      actions = (
        <>
          {[7, 14, 30].map((d) => (
            <button key={d} type="button" className={d === task.payload.cadenceDays ? 'kw-btn kw-small-btn' : 'kw-tool'} disabled={busy} onClick={() => act({ cadenceDays: d })}>
              {d === 7 ? 'Weekly' : d === 14 ? 'Fortnightly' : 'Monthly'}
            </button>
          ))}
          {notNow}
        </>
      );
      break;
    case 'handback':
      actions = (
        <>
          <input className="kw-input kp-reason" placeholder="Outcome to remember (optional)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Outcome" />
          <button type="button" className="kw-btn kw-small-btn" disabled={busy} onClick={() => act({ note: reason })}>Hand back to agent</button>
          <button type="button" className="kw-tool" disabled={busy} onClick={() => later(1)}>I’m still on it</button>
        </>
      );
      break;
    case 'add_value':
      actions = (
        <>
          <input className="kw-input kp-money" inputMode="decimal" placeholder="Quote $" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`${f}'s quote value`} />
          <button type="button" className="kw-btn kw-small-btn" disabled={busy || !money} onClick={() => act({ value: money })}>Save</button>
          {notNow}
        </>
      );
      break;
  }

  return (
    <article className={`kp-task is-p${task.priority} ${compact ? 'is-compact' : ''}`}>
      <span className="kp-task-ic" aria-hidden="true"><Icon name={KIND_ICON[task.kind]} size={17} /></span>
      <div className="kp-task-body">
        <div className="kp-task-top">
          <span className="kp-kind">{KIND_LABEL[task.kind]}</span>
          {onClient && <button type="button" className="kw-linkbtn kp-client" onClick={() => onClient(task.clientId)}>{task.clientName}</button>}
        </div>
        <h4 className="kp-task-t">{task.title}</h4>
        <p className="kp-task-why">{task.reason}</p>
        <div className="kp-task-act">{actions}</div>
      </div>
    </article>
  );
}

export function ActivityFeed({ items, onUndone, onClient }: { items: KwActivity[]; onUndone: () => void; onClient?: (id: string) => void }) {
  const { toast } = useConsole();
  if (!items.length) return <p className="kw-small kp-empty">Nothing yet. Changes to your deals show up here.</p>;
  return (
    <ol className="kp-feed">
      {items.map((a) => (
        <li key={a.id} className={`kp-feed-row is-${a.actor}`}>
          <span className="kp-who">{a.actor === 'agent' ? 'Agent' : 'You'}</span>
          <div className="kp-feed-body">
            <div>{a.detail}</div>
            <div className="kw-small">
              {fmtWhen(a.at)}
              {onClient && a.clientId && <> · <button type="button" className="kw-linkbtn" onClick={() => onClient(a.clientId!)}>Open {firstName(a.clientName)}</button></>}
            </div>
          </div>
          {a.undoable && (
            <button type="button" className="kw-tool" onClick={async () => {
              try { await kw.undoActivity(a.id); toast({ text: 'Undone', tone: 'info' }); onUndone(); } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
            }}>Undo</button>
          )}
        </li>
      ))}
    </ol>
  );
}

export function AgentView({ status, onReview, onClient, onBoard }: { status?: KwStatus; onReview: (id: string) => void; onClient: (id: string) => void; onBoard: () => void }) {
  const { data, err, reload } = useAgent();
  const [checking, setChecking] = useState(false);
  if (err) return <div className="kw-phone"><p className="kw-err">{err}</p><button type="button" className="kw-btn" onClick={() => reload()}>Try again</button></div>;
  if (!data) return <div className="kw-phone"><div className="kw-think"><i />Checking your deals…</div></div>;

  const first = data.tasks.filter((t) => t.priority === 1);
  const rest = data.tasks.filter((t) => t.priority !== 1);
  const check = async () => { setChecking(true); await reload(true); setChecking(false); };

  return (
    <div className="kw-phone kw-enter">
      <div className="kp-head">
        <span className="kp-avatar" aria-hidden="true"><Icon name="ai" size={22} /></span>
        <div className="kw-grow">
          <h2 className="kw-big">Your pipeline agent</h2>
          <p className="kw-sub">{data.brief}</p>
        </div>
      </div>
      <div className="kp-meta">
        <span className={`kp-mode is-${data.mode}`}>
          {data.mode === 'assist' ? 'Handles routine stage moves itself' : 'Asks before changing anything'}
        </span>
        <span className={`kp-mode is-${status?.autoReply ? 'assist' : 'suggest'}`}>
          {status?.autoReply ? 'Auto-replies on' : 'Auto-replies off: you answer every reply'}
        </span>
        <span className="kw-small">Checked {ago(data.lastRunAt)}</span>
        <button type="button" className="kw-tool" disabled={checking} onClick={check}><Icon name="refresh" size={14} /> {checking ? 'Checking…' : 'Check now'}</button>
        <button type="button" className="kw-tool" onClick={onBoard}><Icon name="columns" size={14} /> Board</button>
      </div>

      {data.tasks.length === 0 ? (
        <div className="kw-card kw-center">
          <div className="kw-name">All clear.</div>
          <p className="kw-small">Every open deal has a next step. I’ll check again in 30 minutes and whenever a client replies.</p>
        </div>
      ) : (
        <>
          {first.length > 0 && <h3 className="kw-sec">Do these first</h3>}
          <div className="kp-tasks">{first.map((t) => <TaskCard key={t.id} task={t} onDone={() => reload()} onReview={onReview} onClient={onClient} />)}</div>
          {rest.length > 0 && <h3 className="kw-sec">When you have a minute</h3>}
          <div className="kp-tasks">{rest.map((t) => <TaskCard key={t.id} task={t} onDone={() => reload()} onReview={onReview} onClient={onClient} />)}</div>
        </>
      )}

      <h3 className="kw-sec">What’s been done</h3>
      <ActivityFeed items={data.activity} onUndone={() => reload()} onClient={onClient} />
      <p className="kw-small kp-rule"><Icon name="shield" size={14} />
        {status?.autoReply
          ? ` The agent only answers routine replies itself, waits ${2} minutes so you can step in, and hands anything about price, complaints or a request for a call straight to you.`
          : ' The agent never texts anyone. Every message waits for you to approve it.'}
      </p>
    </div>
  );
}
