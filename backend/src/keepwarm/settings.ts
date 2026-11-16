// Team-wide settings for the sales follow-up agent (Sales admin → Settings).
// Stored as one JSON document in app_settings under 'kw_settings'.
import { KW_METRICS, type KwMetric, type KwSettings } from '@tsba/shared';
import { getSetting, setSetting } from '../settings-repo.js';
import { QUIET, hm } from './time.js';

const KEY = 'kw_settings';

export const DEFAULT_SETTINGS: KwSettings = {
  targets: Object.fromEntries(KW_METRICS.map((m) => [m.k, m.day])) as Record<KwMetric, number>,
  quietStart: '08:00',
  quietEnd: '20:00',
  agentMode: 'suggest',
  autoReply: false,
};

let current: KwSettings = DEFAULT_SETTINGS;

export function settings(): KwSettings {
  return current;
}

function apply(s: KwSettings): void {
  current = s;
  QUIET.start = s.quietStart;
  QUIET.end = s.quietEnd;
}

export async function loadSettings(): Promise<KwSettings> {
  const saved = await getSetting<Partial<KwSettings>>(KEY).catch(() => null);
  apply(normalise(saved ?? {}));
  return current;
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Validate and fill gaps. Send window is kept to 7am–9pm so it stays sensible. */
export function normalise(input: Partial<KwSettings>): KwSettings {
  const targets = { ...DEFAULT_SETTINGS.targets };
  for (const m of KW_METRICS) {
    const v = Number(input.targets?.[m.k]);
    if (Number.isFinite(v) && v >= 0 && v <= 1000) targets[m.k] = Math.round(v);
  }
  let start = HHMM.test(input.quietStart ?? '') ? input.quietStart! : DEFAULT_SETTINGS.quietStart;
  let end = HHMM.test(input.quietEnd ?? '') ? input.quietEnd! : DEFAULT_SETTINGS.quietEnd;
  if (hm(start) < 7 * 60) start = '07:00';
  if (hm(end) > 21 * 60) end = '21:00';
  if (hm(end) - hm(start) < 60) {
    start = DEFAULT_SETTINGS.quietStart;
    end = DEFAULT_SETTINGS.quietEnd;
  }
  const agentMode = input.agentMode === 'assist' ? 'assist' : 'suggest';
  const autoReply = input.autoReply === true;
  return { targets, quietStart: start, quietEnd: end, agentMode, autoReply };
}

export async function saveSettings(input: Partial<KwSettings>): Promise<KwSettings> {
  const s = normalise({ ...current, ...input, targets: { ...current.targets, ...(input.targets ?? {}) } });
  await setSetting(KEY, s);
  apply(s);
  return s;
}
