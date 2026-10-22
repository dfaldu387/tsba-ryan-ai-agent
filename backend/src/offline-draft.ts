import {
  AUTOMATED_RESPONSE_PREFIX,
  type Audience,
  type Channel,
  type DraftResult,
  type KnowledgeEntry,
} from '@tsba/shared';
import { brandMatches, detectBrand, KNOWN_BRANDS } from './brand.js';
import { cleanSentences } from './text-quality.js';

// A no-LLM fallback used when ANTHROPIC_API_KEY is not set, so the preview still
// produces a grounded, cited draft from the retrieved knowledge. Clearly labelled
// in note_for_ryan. When a key IS set, the real Claude path in anthropic.ts is used.
//
// Even without an LLM it aims to be proactive (identify the brand, and ask when
// the answer depends on it) and accurate (answer only from clean, on-topic text —
// never dump a raw ingested PDF chunk; hand to the team when it can't answer well).

const STOP = new Set(
  'the a an and or of to is it in on for my what can i we do does how with this that be are your our you at from need there have has any should could'.split(
    ' ',
  ),
);

// Small domain synonym map so lexical matching bridges wording gaps (the rules
// say "BESS", customers say "battery"; "spacing" vs "clearance", etc.). The LLM
// path doesn't need this; it's only to make the keyless demo rank sensibly.
const SYN: Record<string, string[]> = {
  battery: ['bess'],
  bess: ['battery'],
  spacing: ['clearance', 'within', 'distance', 'horizontally'],
  clearance: ['spacing', 'within'],
  window: ['opening', 'vent'],
  heat: ['appliance'],
  pump: ['appliance'],
};

function tokens(s: string): string[] {
  const base = (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 2 && !STOP.has(t));
  const expanded = new Set(base);
  for (const t of base) for (const syn of SYN[t] ?? []) expanded.add(syn);
  return [...expanded];
}

// Boost added to an entry's lexical score when it matches the detected brand (or
// is brand-agnostic) — same idea as the vector retrieval's BRAND_BONUS.
const BRAND_BOOST = 2;

function score(entry: KnowledgeEntry, terms: string[], brand: string | null): number {
  const hay = `${entry.brand} ${entry.model} ${entry.topic} ${entry.title} ${entry.text}`.toLowerCase();
  let s = 0;
  for (const t of terms) {
    const stem = t.replace(/s$/, '');
    if (hay.includes(stem)) s += 1;
  }
  if (entry.kind === 'rule') s *= 1.3;
  if (brandMatches(entry.brand, brand)) s += BRAND_BOOST;
  return s;
}

/**
 * The best clean snippet of an entry for this question, or null when the entry
 * has no clean on-topic text (so we don't answer from a garbled chunk). Requires
 * at least one query-term hit for accuracy; keeps source order for readability.
 */
function bestSnippet(entry: KnowledgeEntry, terms: string[], channel: Channel): string | null {
  const candidates = cleanSentences(entry.text);
  if (!candidates.length) return null;

  const stems = terms.map((t) => t.replace(/s$/, ''));
  const hits = (s: string) => stems.reduce((n, stem) => (s.toLowerCase().includes(stem) ? n + 1 : n), 0);
  const best = Math.max(...candidates.map(hits));
  if (best === 0) return null; // nothing on-topic in the clean text

  const n = channel === 'text' ? 2 : channel === 'email' ? 4 : 3;
  const chosen = candidates.filter((s) => hits(s) > 0).slice(0, n);
  return chosen.join(' ');
}

/** The first ranked entry that yields a clean, on-topic snippet. */
function firstAnswerable(
  ranked: { e: KnowledgeEntry }[],
  terms: string[],
  channel: Channel,
): { entry: KnowledgeEntry; body: string } | null {
  for (const { e } of ranked.slice(0, 5)) {
    const body = bestSnippet(e, terms, channel);
    if (body) return { entry: e, body };
  }
  return null;
}

/** Humanised brand list for a clarifying question, e.g. "Deye, SAJ or SOFAR". */
function listBrands(brands: string[]): string {
  if (brands.length === 1) return brands[0];
  return `${brands.slice(0, -1).join(', ')} or ${brands[brands.length - 1]}`;
}

/**
 * When the answer depends on the brand and we don't know it, which brands are in
 * play. Returns the distinct brands of the top maker matches, or [] if the brand
 * is known or the match is brand-agnostic (a rule) — i.e. no need to ask.
 */
function brandsToAsk(ranked: { e: KnowledgeEntry }[], brand: string | null): string[] {
  if (brand) return [];
  const top = ranked.slice(0, 4).map((x) => x.e);
  if (top.length && top[0].kind === 'rule') return []; // a general rule answers regardless
  // Only ask about real, known manufacturers — never the neutral 'TSBA Drive' tag.
  const brands = [...new Set(top.filter((e) => KNOWN_BRANDS.includes(e.brand)).map((e) => e.brand))];
  return brands.length >= 2 ? brands : [];
}

const PRICING = /\b(cost|costs|price|priced|pricing|quote|quoted|how much|\$|dollar|cheap|expensive|budget)\b/i;
const LIVE = /\b(cut out|cut off|check why|can you check|won['’]?t come back|look at (my|our|this)|this system|our system|my system|right now|today|happening now|fault code|error code|serial)\b/i;

function isElectrical(entry: KnowledgeEntry | undefined): boolean {
  if (!entry) return false;
  const h = `${entry.topic} ${entry.text}`.toLowerCase();
  return /electric|licensed|switchboard|wiring|energis|energiz|installation & compliance/.test(h);
}

const GREETING = /^\s*(hi|hey|hello|good (morning|afternoon|evening)|g'?day|yo|howdy|how are (you|ya))\b/i;
const THANKS = /\b(thanks|thank you|cheers|appreciate it|ta)\b/i;
const BYE = /\b(bye|goodbye|see ya|that'?s all|nothing else|no thanks)\b/i;

/**
 * A no-LLM conversational reply for the Voice Agent (used when ANTHROPIC_API_KEY
 * isn't set). Handles greetings/thanks naturally, otherwise answers briefly from
 * the retrieved knowledge or offers to hand to the team. Returns plain speech.
 */
export function offlineChat(args: {
  question: string;
  audience: Audience;
  entries: KnowledgeEntry[];
}): string {
  const { question, audience, entries } = args;

  if (GREETING.test(question)) return 'Hello! You’re through to TSBA Technical Support. How can I help you today?';
  if (BYE.test(question)) return 'No worries at all. Thanks for calling TSBA, and have a great day!';
  if (THANKS.test(question)) return 'You’re very welcome. Is there anything else I can help you with?';
  if (PRICING.test(question))
    return 'Pricing isn’t something we handle here in technical support, but I can pass you to the TSBA sales team who’ll sort out a price for you. Would you like me to do that?';

  const brand = detectBrand(question);
  const terms = tokens(question);
  const ranked = entries
    .map((e) => ({ e, s: score(e, terms, brand) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  // Proactive: if the right answer depends on the brand and we don't know it, ask.
  const ask = brandsToAsk(ranked, brand);
  if (ask.length) {
    return `Happy to help with that. Which inverter are you using — ${listBrands(ask)}? Once I know, I can give you the right steps for your model.`;
  }

  // Accurate: answer only from clean, on-topic text; otherwise hand to the team.
  const answer = LIVE.test(question) ? null : firstAnswerable(ranked, terms, 'chat');
  if (!answer) {
    return 'That’s a good question. I’d like our team to take a proper look at that one, so I’ll pass it on and they’ll be in touch shortly. Is there anything else I can help with in the meantime?';
  }

  let reply = answer.body;
  if (audience === 'customer' && isElectrical(answer.entry)) {
    reply += ' Just to note, anything involving electrical work needs a licensed electrician, and TSBA can arrange that for you.';
  }
  return reply;
}

export function offlineDraft(args: {
  question: string;
  audience: Audience;
  channel: Channel;
  entries: KnowledgeEntry[];
}): DraftResult {
  const { question, audience, channel, entries } = args;
  const brand = detectBrand(question);
  const terms = tokens(question);
  const ranked = entries
    .map((e) => ({ e, s: score(e, terms, brand) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const note =
    'Offline demo draft — composed from the retrieved knowledge with no LLM (ANTHROPIC_API_KEY not set). ' +
    'Set the key for full Claude drafting. Review wording before approving.';

  // Pricing → decline.
  if (PRICING.test(question)) {
    return {
      outcome: 'decline',
      reply: `${AUTOMATED_RESPONSE_PREFIX}\n\nPricing and quotes aren’t handled here in technical support. I’ll pass you to the TSBA sales team, who can give you an installed price.`,
      sources: [],
      note_for_ryan: note,
      team_handover: null,
    };
  }

  // Proactive: if the right answer depends on the brand and we don't know it,
  // ask which one instead of guessing — step 2 of the support flow.
  const ask = brandsToAsk(ranked, brand);
  if (ask.length) {
    return {
      outcome: 'clarify',
      reply: `${AUTOMATED_RESPONSE_PREFIX}\n\nHappy to help with that. Which inverter are you using — ${listBrands(ask)}? Once I know the brand I can give you the exact steps for your model.`,
      sources: [],
      note_for_ryan: `${note} Asked which brand (the answer differs by manufacturer and none was given).`,
      team_handover: null,
    };
  }

  // Accurate: answer only from a clean, on-topic snippet. A live/site-specific
  // request, no match, or only garbled chunks → hand to the team rather than
  // read back raw text.
  const answer = LIVE.test(question) ? null : firstAnswerable(ranked, terms, channel);
  if (!answer) {
    return {
      outcome: 'handover',
      reply: `${AUTOMATED_RESPONSE_PREFIX}\n\nThanks for the details. This one needs our team to look at the actual system, so I’ve passed it on with what you’ve told me — they’ll be in touch shortly and you won’t need to repeat it.`,
      sources: ranked.slice(0, 2).map((x) => x.e.id),
      note_for_ryan: `${note} No clean on-topic match offline — handed over rather than answer from a low-quality chunk.`,
      team_handover: {
        summary: `${question.slice(0, 120)}`,
        needed: ['Brand, model and serial', 'What changed and when', 'Inverter/app screen status', 'Any error shown'],
      },
    };
  }

  const lead = answer.entry;
  const attribution =
    lead.kind === 'rule'
      ? 'This is from TSBA’s verified rules'
      : `This is from ${lead.brand} technical support (pending TSBA approval)`;

  let reply = `${AUTOMATED_RESPONSE_PREFIX}\n\n${answer.body}\n\n${attribution}.`;
  if (audience === 'customer' && isElectrical(lead)) {
    reply += '\n\nAnything involving electrical work must be done by a licensed electrician — TSBA can arrange that for you.';
  }

  return {
    outcome: 'answer',
    reply,
    sources: [lead.id],
    note_for_ryan: note,
    team_handover: null,
  };
}
