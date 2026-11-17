// The rep's deal board: one column per stage, drag a card (or use its menu)
// to move it. Totals and a probability-weighted forecast sit on top. Cards
// the agent has something to say about carry a marker.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { KW_OPEN_STAGES, KW_STAGES } from '@tsba/shared';
import { AuthError, kw } from '../../api';
import { useConsole } from '../../lib/console';
import type { KwAgentTask, KwClient, KwStage } from '../../lib/kw-types';
import { PLANT_TZ } from '../../lib/format';
import { Icon, Menu } from '../../ui';
import { Ring, errText } from './parts';
import './pipeline.css';

export const money = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}m` : n >= 10_000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n).toLocaleString('en-AU')}`;

const prob = (s: KwStage) => KW_STAGES.find((x) => x.id === s)!.prob;
const stale = (c: KwClient) => {
  const s = KW_STAGES.find((x) => x.id === c.dealStage)!;
  return s.staleDays > 0 && c.daysInStage >= s.staleDays;
};

/** "YYYY-MM" of a moment, in Australia/Sydney. */
const sydneyMonth = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: PLANT_TZ }).slice(0, 7);

export function stageTotals(clients: KwClient[]) {
  const live = clients.filter((c) => !c.optedOut || c.dealStage === 'won' || c.dealStage === 'lost');
  const open = live.filter((c) => KW_OPEN_STAGES.includes(c.dealStage));
  // Calendar month in Sydney time, for "now" and for each deal: comparing UTC
  // months put a deal won on 1 Dec 9am AEDT into November.
  const month = sydneyMonth(new Date());
  return {
    openCount: open.length,
    openValue: open.reduce((s, c) => s + (c.dealValue ?? 0), 0),
    weighted: open.reduce((s, c) => s + (c.dealValue ?? 0) * prob(c.dealStage), 0),
    wonMonth: live.filter((c) => c.dealStage === 'won' && sydneyMonth(new Date(c.stageChangedAt)) === month).reduce((s, c) => s + (c.dealValue ?? 0), 0),
    noValue: open.filter((c) => c.dealValue == null && (c.dealStage === 'quoted' || c.dealStage === 'negotiating')).length,
  };
}

export function Board({ onClient, onAgent }: { onClient: (id: string) => void; onAgent: () => void }) {
  const { toast, onAuthError } = useConsole();
  const [clients, setClients] = useState<KwClient[] | null>(null);
  const [tasks, setTasks] = useState<KwAgentTask[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<KwStage | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([kw.clients(), kw.agent()]);
      setClients(c.clients);
      setTasks(a.tasks);
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else setErr(errText(e));
    }
  }, [onAuthError]);
  useEffect(() => { void load(); }, [load]);

  const move = async (id: string, to: KwStage) => {
    const c = clients?.find((x) => x.id === id);
    if (!c || c.dealStage === to) return;
    // Optimistic: the card lands immediately, rolls back on error.
    setClients((cs) => cs?.map((x) => (x.id === id ? { ...x, dealStage: to, daysInStage: 0 } : x)) ?? null);
    try {
      await kw.updateClient(id, { dealStage: to });
      void load();
    } catch (e) {
      toast({ text: errText(e), tone: 'danger' });
      void load();
    }
  };

  const flagged = useMemo(() => new Set(tasks.map((t) => t.clientId)), [tasks]);
  const totals = useMemo(() => stageTotals(clients ?? []), [clients]);

  if (err) return <div className="kw-phone"><p className="kw-err">{err}</p></div>;
  if (!clients) return <div className="kw-phone"><div className="kw-think"><i />Loading your pipeline…</div></div>;

  const stages = KW_STAGES.filter((s) => showClosed || KW_OPEN_STAGES.includes(s.id) || s.id === 'won');

  return (
    <div className="kp-board-wrap kw-enter">
      <div className="kp-board-head">
        <div className="kw-grow">
          <h2 className="kw-big">Pipeline</h2>
          <p className="kw-sub">Drag a deal to move it. The agent watches each stage and tells you when something has sat too long.</p>
        </div>
        <button type="button" className="kw-tool" onClick={onAgent}><Icon name="ai" size={15} /> Agent{tasks.length ? ` · ${tasks.length}` : ''}</button>
        <button type="button" className="kw-tool" aria-pressed={showClosed} onClick={() => setShowClosed((v) => !v)}>{showClosed ? 'Hide lost' : 'Show lost'}</button>
      </div>

      <dl className="kp-totals">
        <div><dt>Open deals</dt><dd>{totals.openCount}</dd></div>
        <div><dt>Quoted value</dt><dd>{money(totals.openValue)}</dd></div>
        <div><dt>Weighted forecast</dt><dd>{money(totals.weighted)}</dd><span className="kw-small">value × stage odds</span></div>
        <div><dt>Won this month</dt><dd>{money(totals.wonMonth)}</dd></div>
      </dl>
      {totals.noValue > 0 && <p className="kw-small kp-warnline"><Icon name="alert" size={14} /> {totals.noValue} quoted deal{totals.noValue > 1 ? 's have' : ' has'} no value, so the forecast is short.</p>}

      <div className="kp-board" role="list" aria-label="Deal stages">
        {stages.map((s) => {
          const cards = clients.filter((c) => c.dealStage === s.id).sort((a, b) => b.daysInStage - a.daysInStage);
          const value = cards.reduce((t, c) => t + (c.dealValue ?? 0), 0);
          return (
            <section key={s.id} role="listitem" className={`kp-col is-${s.id} ${over === s.id ? 'is-over' : ''}`} aria-label={`${s.label}, ${cards.length} deals`}
              onDragOver={(e) => { if (drag) { e.preventDefault(); setOver(s.id); } }}
              onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
              onDrop={(e) => { e.preventDefault(); setOver(null); if (drag) void move(drag, s.id); setDrag(null); }}>
              <header className="kp-col-h">
                <span className="kp-col-t">{s.label}</span>
                <span className="kp-col-n">{cards.length}</span>
                <span className="kp-col-v">{value ? money(value) : ''}</span>
              </header>
              <div className="kp-col-body">
                {cards.length === 0 && <div className="kp-col-empty">{s.hint}</div>}
                {cards.map((c) => (
                  <div key={c.id} className={`kp-card ${drag === c.id ? 'is-drag' : ''}`} draggable
                    onDragStart={(e) => { setDrag(c.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.id); }}
                    onDragEnd={() => { setDrag(null); setOver(null); }}>
                    <button type="button" className="kp-card-main" onClick={() => onClient(c.id)}>
                      <Ring client={c} size={32} />
                      <span className="kp-card-txt">
                        <span className="kp-card-name">{c.name}</span>
                        <span className="kp-card-sub">
                          {c.dealValue != null ? money(c.dealValue) : 'No value'}
                          {' · '}
                          <span className={stale(c) ? 'kp-stale' : ''}>{c.daysInStage === 0 ? 'today' : `${c.daysInStage}d here`}</span>
                          {flagged.has(c.id) && <span className="kp-flag" title="The agent has a suggestion for this deal"><Icon name="ai" size={12} /><span className="c-sr">Agent suggestion</span></span>}
                        </span>
                      </span>
                    </button>
                    <Menu label={`Move ${c.name}`} items={KW_STAGES.filter((x) => x.id !== c.dealStage).map((x) => ({ label: `Move to ${x.label}`, onSelect: () => void move(c.id, x.id) }))} />
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
