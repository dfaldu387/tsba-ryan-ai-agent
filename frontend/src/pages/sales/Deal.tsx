// Deal fields on the client screen: stage, value, expected close. Saves as
// soon as a field changes; stage moves are logged in the deal's history.
import { useState } from 'react';
import { KW_STAGES } from '@tsba/shared';
import { kw } from '../../api';
import { useConsole } from '../../lib/console';
import type { KwClient, KwStage } from '../../lib/kw-types';
import { errText } from './parts';
import './pipeline.css';

export function DealPanel({ client, onSaved }: { client: KwClient; onSaved: (c: KwClient) => void }) {
  const { toast } = useConsole();
  const [value, setValue] = useState(client.dealValue != null ? String(client.dealValue) : '');
  const [busy, setBusy] = useState(false);

  const save = async (patch: Parameters<typeof kw.updateClient>[1], note?: string) => {
    setBusy(true);
    try {
      const c = await kw.updateClient(client.id, patch);
      onSaved(c);
      if (note) toast({ text: note, tone: 'success' });
    } catch (e) {
      toast({ text: errText(e), tone: 'danger' });
    } finally { setBusy(false); }
  };

  const saveValue = () => {
    const raw = value.replace(/[^\d.]/g, '');
    const next = raw ? Math.round(Number(raw)) : null;
    if (next === client.dealValue) return;
    void save({ dealValue: next });
  };

  return (
    <div className="kw-card kp-deal">
      <div className="kp-stages" role="group" aria-label="Pipeline stage">
        {KW_STAGES.map((s) => (
          <button key={s.id} type="button" className="kp-stage-btn" aria-pressed={client.dealStage === s.id} disabled={busy} title={s.hint}
            onClick={() => client.dealStage !== s.id && void save({ dealStage: s.id as KwStage }, `Moved to ${s.label}`)}>
            {s.label}
          </button>
        ))}
      </div>
      <label>
        Deal value ($)
        <input className="kw-input" inputMode="decimal" placeholder="e.g. 14500" value={value}
          onChange={(e) => setValue(e.target.value)} onBlur={saveValue} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </label>
      <label>
        Expected to decide by
        <input className="kw-input" type="date" value={client.expectedClose ?? ''} disabled={busy}
          onChange={(e) => void save({ expectedClose: e.target.value || null })} />
      </label>
      <div className="kw-small is-full">
        {KW_STAGES.find((s) => s.id === client.dealStage)?.label} for {client.daysInStage === 0 ? 'less than a day' : `${client.daysInStage} day${client.daysInStage > 1 ? 's' : ''}`}
        {client.dealStage === 'lost' && client.lostReason ? ` · ${client.lostReason}` : ''}
      </div>
    </div>
  );
}
