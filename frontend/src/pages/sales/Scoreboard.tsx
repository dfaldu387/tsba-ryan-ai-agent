// Scoreboard (page 103: seven inputs and revenue, nothing else).
import { useCallback, useEffect, useState } from 'react';
import { KW_METRICS } from '@tsba/shared';
import { AuthError, kw } from '../../api';
import { useConsole } from '../../lib/console';
import type { KwMetric, KwScoreboard } from '../../lib/kw-types';
import { Icon } from '../../ui';
import { VoiceBox, errText } from './parts';

const money = (n: number) => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

export function Scoreboard({ targets }: { targets: Record<KwMetric, number> }) {
  const { toast, onAuthError } = useConsole();
  const [range, setRange] = useState<'day' | 'week'>('day');
  const [board, setBoard] = useState<KwScoreboard | null>(null);
  const [voice, setVoice] = useState(false);
  const [said, setSaid] = useState('');
  const [sale, setSale] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    kw.score(range).then(setBoard).catch((e) => (e instanceof AuthError ? onAuthError() : toast({ text: errText(e), tone: 'danger' })));
  }, [range, onAuthError, toast]);
  useEffect(load, [load]);

  const bump = async (metric: string, delta: number) => {
    try {
      const b = await kw.logScore(metric, delta);
      if (range === 'day') setBoard(b);
      else load();
    } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
  };

  const logVoice = async () => {
    setBusy(true);
    try {
      const r = await kw.logScoreVoice(said);
      const parts = Object.entries(r.added).map(([k, v]) => (k === 'revenue' ? money(v) : `${v} ${KW_METRICS.find((m) => m.k === k)?.label.toLowerCase() ?? k}`));
      toast({ text: parts.length ? `Logged ${parts.join(', ')}` : 'Couldn’t pick out any numbers. Try “25 calls, 6 conversations”.', tone: parts.length ? 'success' : 'info' });
      if (parts.length) { setSaid(''); setVoice(false); setRange('day'); setBoard(r.board); }
    } catch (e) { toast({ text: errText(e), tone: 'danger' }); }
    finally { setBusy(false); }
  };

  const mult = range === 'week' ? 5 : 1;
  return (
    <div className="kw-phone kw-enter">
      <h2 className="kw-big">Scoreboard</h2>
      <p className="kw-sub">Track the essentials, don’t drown in data. Follow-ups and pipeline additions count themselves.</p>
      <div className="kw-seg" role="group" aria-label="Range">
        <button type="button" aria-pressed={range === 'day'} onClick={() => setRange('day')}>Today</button>
        <button type="button" aria-pressed={range === 'week'} onClick={() => setRange('week')}>This week</button>
      </div>

      {!board ? <div className="kw-think"><i />Loading…</div> : (
        <>
          <div className="kw-list kw-metrics">
            {KW_METRICS.map((m) => {
              const v = board.score[m.k];
              const target = Math.max(1, targets[m.k] * mult);
              return (
                <div key={m.k} className="kw-card kw-metric">
                  <div className="kw-grow">
                    <div className="kw-rowline"><span className="kw-name">{m.label}</span>{m.auto && <span className="kw-tag is-auto">Counted for you</span>}</div>
                    <div className="kw-small">{m.hint}</div>
                    <div className="kw-bar-track" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={target} aria-label={`${m.label}: ${v} of ${target}`}>
                      <i style={{ width: `${Math.min(100, (v / target) * 100)}%` }} className={v >= target ? 'is-hit' : ''} />
                    </div>
                  </div>
                  <div className="kw-metric-n"><b>{v}</b><span>of {target}</span></div>
                  {!m.auto && range === 'day' && (
                    <div className="kw-stepper">
                      <button type="button" aria-label={`One less ${m.label.toLowerCase()}`} disabled={v <= 0} onClick={() => bump(m.k, -1)}>−</button>
                      <button type="button" aria-label={`One more ${m.label.toLowerCase()}`} onClick={() => bump(m.k, 1)}>+</button>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="kw-card kw-metric is-revenue">
              <div className="kw-grow">
                <div className="kw-name">Revenue</div>
                <div className="kw-small">The result the seven inputs drive</div>
              </div>
              <div className="kw-metric-n"><b>{money(board.score.revenue)}</b></div>
            </div>
          </div>

          {range === 'week' && board.days.length > 0 && (
            <div className="kw-card kw-week">
              {board.days.map((d) => (
                <div key={d.date}>
                  <span>{new Date(`${d.date}T12:00:00`).toLocaleDateString('en-AU', { weekday: 'short' })}</span>
                  <b>{d.score.followups}</b>
                  <i style={{ height: `${Math.min(100, (d.score.followups / Math.max(1, targets.followups)) * 100)}%` }} />
                </div>
              ))}
              <p className="kw-small">Follow-ups per day</p>
            </div>
          )}

          {range === 'day' && (
            <>
              <div className="kw-tools">
                <button type="button" className={`kw-tool ${voice ? 'is-on' : ''}`} onClick={() => setVoice((v) => !v)}><Icon name="voice" size={15} /> Log by voice</button>
              </div>
              {voice && (
                <div className="kw-prompt">
                  <VoiceBox label="What did you do today?" value={said} onChange={setSaid} rows={3}
                    placeholder="Made 25 calls, had 6 conversations, booked 2 meetings and closed an $18,400 job." />
                  <button type="button" className="kw-btn kw-small-btn" disabled={!said.trim() || busy} onClick={logVoice}>{busy ? 'Logging…' : 'Log it'}</button>
                </div>
              )}
              <div className="kw-card kw-sale">
                <label className="kw-name" htmlFor="kw-sale">Closed a sale today?</label>
                <div className="kw-rowline">
                  <input id="kw-sale" className="kw-input" inputMode="decimal" placeholder="$ amount" value={sale} onChange={(e) => setSale(e.target.value)} />
                  <button type="button" className="kw-btn kw-small-btn" disabled={!Number(sale.replace(/[$,\s]/g, ''))} onClick={async () => {
                    await bump('revenue', Math.round(Number(sale.replace(/[$,\s]/g, ''))));
                    setSale('');
                  }}>Add</button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
