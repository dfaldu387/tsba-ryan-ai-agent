// AI Solar Assistant entry point. Headline fleet questions are answered
// deterministically from the live data already loaded in the console (so the
// numbers are exactly what the dashboard shows and nothing is fabricated);
// anything else is forwarded to the existing grounded /api/voice/chat pipeline.
import { useState } from 'react';
import { AuthError, supportChat, type SolarAlertsResult, type SolarStation } from '../../api';
import { fmtCapacity, fmtEnergy, fmtPower } from './format';
import { ICON, SectionCard } from './ui';

export interface FleetSummary {
  count: number;
  online: number;
  power: number;
  daily: number;
  monthly: number;
  total: number;
  capacity: number;
}

interface Answer {
  text: string;
  facts?: { label: string; value: string }[];
  period?: string;
  source: string;
}

const SUGGESTED = [
  'What is the current power generation across all plants?',
  'Which plants are offline?',
  'Which plant produced the most energy today?',
  'What is the total installed solar capacity?',
  'Which stations have active alerts?',
  'Give me a production summary for today.',
];

/** Answer a recognised fleet question from loaded data; null → not recognised. */
function localAnswer(
  q: string,
  stations: SolarStation[],
  alerts: SolarAlertsResult | null,
  summary: FleetSummary,
  providerName: (id: string) => string,
): Answer | null {
  const t = q.toLowerCase();
  const src = 'Live fleet data (this dashboard)';

  if (/(current|now|real.?time|right now).*(power|generation|generating)|total power|how much.*generat/.test(t)) {
    return {
      text: `The portfolio is currently generating ${fmtPower(summary.power)} across ${summary.online} of ${summary.count} plants reporting online.`,
      facts: [{ label: 'Current power', value: fmtPower(summary.power) }, { label: 'Plants online', value: `${summary.online}/${summary.count}` }],
      period: 'Now',
      source: src,
    };
  }
  if (/offline|down|not reporting|disconnect/.test(t)) {
    const off = stations.filter((s) => s.status === 'offline');
    return {
      text: off.length === 0 ? 'No plants are currently offline — the whole fleet is reporting.' : `${off.length} plant${off.length === 1 ? ' is' : 's are'} offline.`,
      facts: off.slice(0, 12).map((s) => ({ label: s.name, value: providerName(s.provider) })),
      period: 'Now',
      source: src,
    };
  }
  if (/most.*(energy|produc)|top.*produc|highest.*produc|best.*plant/.test(t)) {
    const top = [...stations].filter((s) => s.dailyEnergyKwh != null).sort((a, b) => (b.dailyEnergyKwh ?? 0) - (a.dailyEnergyKwh ?? 0))[0];
    if (!top) return { text: 'No plants have reported today’s production yet.', source: src, period: 'Today' };
    return {
      text: `${top.name} produced the most energy today, ${fmtEnergy(top.dailyEnergyKwh)}.`,
      facts: [{ label: 'Plant', value: top.name }, { label: 'Today', value: fmtEnergy(top.dailyEnergyKwh) }, { label: 'Provider', value: providerName(top.provider) }],
      period: 'Today',
      source: src,
    };
  }
  if (/(installed|total).*capacit|how (big|much).*capacit|kwp/.test(t)) {
    return {
      text: `The total installed capacity across the portfolio is ${fmtCapacity(summary.capacity)} over ${summary.count} plants.`,
      facts: [{ label: 'Installed capacity', value: fmtCapacity(summary.capacity) }, { label: 'Plants', value: String(summary.count) }],
      source: src,
    };
  }
  if (/alert|fault|warning|problem|issue|communication/.test(t)) {
    if (!alerts) return { text: 'The alert scan hasn’t finished loading yet — check the Alerts tab in a moment.', source: src };
    const byPlant = new Map<string, number>();
    for (const a of alerts.alerts) byPlant.set(a.plant, (byPlant.get(a.plant) ?? 0) + 1);
    return {
      text: alerts.alerts.length === 0
        ? 'There are no active alerts across the fleet.'
        : `${alerts.alerts.length} active alert${alerts.alerts.length === 1 ? '' : 's'} across ${byPlant.size} plant${byPlant.size === 1 ? '' : 's'}.`,
      facts: [...byPlant.entries()].slice(0, 12).map(([plant, n]) => ({ label: plant, value: `${n} alert${n === 1 ? '' : 's'}` })),
      period: alerts.generatedAt ? `Scanned ${new Date(alerts.generatedAt).toLocaleTimeString()}` : undefined,
      source: 'Live fleet alert scan',
    };
  }
  if (/summary|overview|today|how.*doing|status/.test(t)) {
    return {
      text: `Today so far: ${fmtEnergy(summary.daily)} produced, ${fmtPower(summary.power)} generating now, ${summary.online}/${summary.count} plants online. This month: ${fmtEnergy(summary.monthly)}.`,
      facts: [
        { label: 'Today', value: fmtEnergy(summary.daily) },
        { label: 'Current power', value: fmtPower(summary.power) },
        { label: 'This month', value: fmtEnergy(summary.monthly) },
        { label: 'Online', value: `${summary.online}/${summary.count}` },
      ],
      period: 'Today',
      source: src,
    };
  }
  return null;
}

export function AssistantCard({
  stations, alerts, summary, lastUpdated, providerName, onAuthError,
}: {
  stations: SolarStation[];
  alerts: SolarAlertsResult | null;
  summary: FleetSummary;
  lastUpdated: number | null;
  providerName: (id: string) => string;
  onAuthError?: () => void;
}) {
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const ask = async (question: string) => {
    const query = question.trim();
    if (!query || busy) return;
    setErr('');
    setAnswer(null);
    const local = localAnswer(query, stations, alerts, summary, providerName);
    if (local) {
      setAnswer(local);
      return;
    }
    // Not a headline question → the grounded agent.
    setBusy(true);
    try {
      const res = await supportChat([{ role: 'user', content: query }]);
      setAnswer({ text: res.reply, source: 'TSBA AI assistant (grounded)' });
    } catch (e) {
      if (e instanceof AuthError) return onAuthError?.();
      setErr('The assistant couldn’t answer that right now. Try one of the suggested questions.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard title="Ask the solar assistant" eyebrow="Answers from live fleet data" className="solar-ai">
      <div className="solar-ai-row">
        <span className="solar-ai-ico">{ICON.ai}</span>
        <input
          className="solar-ai-input"
          placeholder="Ask about production, offline plants, capacity, alerts…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask(q)}
          aria-label="Ask the solar assistant"
        />
        <button type="button" className="solar-ai-send" onClick={() => ask(q)} disabled={busy || !q.trim()}>
          {busy ? '…' : 'Ask'}
        </button>
      </div>

      <div className="solar-ai-chips">
        {SUGGESTED.map((s) => (
          <button key={s} type="button" className="solar-ai-chip" onClick={() => { setQ(s); ask(s); }}>{s}</button>
        ))}
      </div>

      {err && <span className="err">{err}</span>}

      {answer && (
        <div className="solar-ai-answer">
          <p className="solar-ai-text">{answer.text}</p>
          {answer.facts && answer.facts.length > 0 && (
            <div className="solar-ai-facts">
              {answer.facts.map((f, i) => (
                <div className="solar-ai-fact" key={`${f.label}-${i}`}>
                  <span className="solar-ai-fact-l">{f.label}</span>
                  <span className="solar-ai-fact-v solar-mono">{f.value}</span>
                </div>
              ))}
            </div>
          )}
          <div className="solar-ai-foot">
            <span>Source: {answer.source}</span>
            {answer.period && <span>· {answer.period}</span>}
            {lastUpdated && <span>· Updated {new Date(lastUpdated).toLocaleTimeString()}</span>}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
