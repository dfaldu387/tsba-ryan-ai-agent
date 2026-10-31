import { AUTOMATED_RESPONSE_PREFIX, type DraftResult } from '@tsba/shared';
import { detectBrand, KNOWN_BRANDS, type Brand } from './brand.js';

// ─── Monitoring-app disambiguation ───────────────────────────────────────────
// A question like "How do I add my inverter to the monitoring app?" cannot be
// answered until we know WHICH inverter: each brand has its own app (Deye →
// Solarman, Solis → SolisCloud, GoodWe → SEMS Portal, …). Rather than spend a
// retrieval + model round-trip only to have the model ask "which inverter?", we
// detect this class of question up front and, when the brand is still unknown,
// return a ready clarify with the brand options — costing ZERO model tokens.
//
// Once the brand IS known (named in the question, resolved from the app name, or
// said earlier in a voice call) we do nothing here: the normal grounded flow
// answers it, using the per-brand APP-* knowledge entries in data/.

/** Monitoring app per inverter brand — the canonical answer, for reference/tests. */
export const MONITORING_APPS: Record<string, string> = {
  Deye: 'SOLARMAN Smart',
  SOFAR: 'SOLARMAN Smart',
  Solis: 'SolisCloud',
  Sungrow: 'iSolarCloud',
  GoodWe: 'SEMS Portal',
  Fronius: 'Fronius Solar.web',
  Growatt: 'ShinePhone',
  Tesla: 'the Tesla app',
  SAJ: 'SAJ eSolar',
};

// App names that unambiguously identify ONE brand, so naming the app is as good
// as naming the inverter. Solarman is deliberately omitted — it serves both Deye
// and SOFAR, so it does NOT pin a single brand.
const APP_TO_BRAND: Array<{ brand: Brand; re: RegExp }> = [
  { brand: 'Solis', re: /\bsolis\s?cloud\b/i },
  { brand: 'Sungrow', re: /\bisolar\s?cloud\b/i },
  { brand: 'GoodWe', re: /\bsems\b|\bpv\s?master\b/i },
  { brand: 'Fronius', re: /\bsolar\.?web\b/i },
  { brand: 'Growatt', re: /\bshine\s?(?:phone|server|wifi|link)\b/i },
  { brand: 'SAJ', re: /\besolar\b/i },
];

/** Resolve a brand from an unambiguous monitoring-app name in the text, else null. */
export function brandFromApp(text: string): Brand | null {
  if (!text) return null;
  for (const { brand, re } of APP_TO_BRAND) if (re.test(text)) return brand;
  return null;
}

/**
 * Best brand for a message: named inverter brand first, then an unambiguous app
 * name. Used so "how do I use SolisCloud" counts as a Solis question.
 */
export function resolveBrand(text: string): Brand | null {
  return detectBrand(text) ?? brandFromApp(text);
}

// A monitoring/app token — the topic has to actually be about monitoring/an app.
const APP_TOKEN =
  /\b(monitoring|monitor|the app|an app|which app|what app|portal|platform|dashboard|data\s?logger|wi-?fi (?:stick|dongle|module)|solarman|solis\s?cloud|isolar\s?cloud|sems|shine\s?phone|solar\.?web|esolar)\b/i;
// A context token — it has to be about the user's inverter/system, not e.g. an
// unrelated "is there an app for warranty claims".
const CONTEXT_TOKEN = /\b(inverter|system|device|battery|powerwall|plant|station|solar|my)\b/i;

/**
 * True when the message is about getting an inverter/system onto its monitoring
 * app (the canonical "it depends which inverter" intent). Conservative: needs
 * both a monitoring/app token and an inverter/system context token.
 */
export function isMonitoringAppIntent(text: string): boolean {
  if (!text) return false;
  return APP_TOKEN.test(text) && CONTEXT_TOKEN.test(text);
}

function brandList(): string {
  return KNOWN_BRANDS.join(', ');
}

/** First-person chips the user can tap to supply the brand (for the voice UI). */
export function brandChips(): string[] {
  return KNOWN_BRANDS.slice(0, 4).map((b) => `I have a ${b}`);
}

/**
 * A ready clarify for a monitoring-app question with no brand yet — built with no
 * model call. Returns null when it doesn't apply (not this intent, or the brand
 * is already known, in which case the normal grounded flow answers it).
 */
export function preClarifyDraft(args: { question: string; brand: Brand | null }): DraftResult | null {
  if (args.brand) return null;
  if (!isMonitoringAppIntent(args.question)) return null;
  return {
    outcome: 'clarify',
    reply:
      `${AUTOMATED_RESPONSE_PREFIX} Happy to help you get your system onto its monitoring app. ` +
      `Each inverter brand uses its own app, so I just need to know which inverter you have. ` +
      `Which brand is it — for example ${brandList()}? If you know the model too, even better.`,
    sources: [],
    note_for_ryan:
      'Auto-clarify (no model call): a monitoring-app question with no inverter brand named. Once the brand is given, the APP-* knowledge answers it directly.',
    team_handover: null,
  };
}

/** The voice equivalent: a spoken clarify plus tappable brand chips, no model call. */
export function preClarifyVoice(args: {
  question: string;
  brand: Brand | null;
}): { reply: string; suggestions: string[] } | null {
  if (args.brand) return null;
  if (!isMonitoringAppIntent(args.question)) return null;
  return {
    reply:
      `${AUTOMATED_RESPONSE_PREFIX} Happy to help with that. Each inverter brand has its own ` +
      `monitoring app, so which inverter have you got? For example ${brandList()}.`,
    suggestions: brandChips(),
  };
}
