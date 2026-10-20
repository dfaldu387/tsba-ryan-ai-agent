import {
  AUTOMATED_RESPONSE_PREFIX,
  type Audience,
  type Channel,
  type DraftResult,
  type KnowledgeEntry,
} from '@tsba/shared';

// A no-LLM fallback used when ANTHROPIC_API_KEY is not set, so the preview still
// produces a grounded, cited draft from the retrieved knowledge. Clearly labelled
// in note_for_ryan. When a key IS set, the real Claude path in anthropic.ts is used.

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

function score(entry: KnowledgeEntry, terms: string[]): number {
  const hay = `${entry.brand} ${entry.model} ${entry.topic} ${entry.title} ${entry.text}`.toLowerCase();
  let s = 0;
  for (const t of terms) {
    const stem = t.replace(/s$/, '');
    if (hay.includes(stem)) s += 1;
  }
  return entry.kind === 'rule' ? s * 1.3 : s;
}

function sentences(text: string, channel: Channel): string {
  const parts = text.split(/(?<=[.!?])\s+/);
  const n = channel === 'text' ? 2 : channel === 'email' ? 4 : 3;
  return parts.slice(0, n).join(' ');
}

const PRICING = /\b(cost|costs|price|priced|pricing|quote|quoted|how much|\$|dollar|cheap|expensive|budget)\b/i;
const LIVE = /\b(cut out|cut off|check why|can you check|won['’]?t come back|look at (my|our|this)|this system|our system|my system|right now|today|happening now|fault code|error code|serial)\b/i;

function isElectrical(entry: KnowledgeEntry | undefined): boolean {
  if (!entry) return false;
  const h = `${entry.topic} ${entry.text}`.toLowerCase();
  return /electric|licensed|switchboard|wiring|energis|energiz|installation & compliance/.test(h);
}

export function offlineDraft(args: {
  question: string;
  audience: Audience;
  channel: Channel;
  entries: KnowledgeEntry[];
}): DraftResult {
  const { question, audience, channel, entries } = args;
  const terms = tokens(question);
  const ranked = entries
    .map((e) => ({ e, s: score(e, terms) }))
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

  // No usable match, or a live/site-specific request → hand to the team.
  if (ranked.length === 0 || LIVE.test(question)) {
    return {
      outcome: 'handover',
      reply: `${AUTOMATED_RESPONSE_PREFIX}\n\nThanks for the details. This one needs our team to look at the actual system, so I’ve passed it on with what you’ve told me — they’ll be in touch shortly and you won’t need to repeat it.`,
      sources: ranked.slice(0, 2).map((x) => x.e.id),
      note_for_ryan: note,
      team_handover: {
        summary: `${question.slice(0, 120)}`,
        needed: ['Brand, model and serial', 'What changed and when', 'Inverter/app screen status', 'Any error shown'],
      },
    };
  }

  // Answer from the top entries.
  const top = ranked.slice(0, 2).map((x) => x.e);
  const lead = top[0];
  const body = sentences(lead.text, channel);
  const attribution =
    lead.kind === 'rule'
      ? 'This is from TSBA’s verified rules'
      : `This is from ${lead.brand} technical support (pending TSBA approval)`;

  let reply = `${AUTOMATED_RESPONSE_PREFIX}\n\n${body}\n\n${attribution}.`;
  if (audience === 'customer' && isElectrical(lead)) {
    reply += '\n\nAnything involving electrical work must be done by a licensed electrician — TSBA can arrange that for you.';
  }

  return {
    outcome: 'answer',
    reply,
    sources: top.map((e) => e.id),
    note_for_ryan: note,
    team_handover: null,
  };
}
