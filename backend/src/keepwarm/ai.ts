// Claude calls for the sales follow-up agent. Each returns JSON and has an
// offline fallback, so the agent keeps working (more plainly) without an API key.
import Anthropic from '@anthropic-ai/sdk';
import {
  KW_NOTE_CATS,
  type KwLoggedMetric,
  type KwMessageKind,
  type KwMix,
  type KwNote,
  type KwNoteCat,
  type KwStage,
  type KwTextType,
  type KwUnderstood,
} from '@tsba/shared';
import { env } from '../env.js';
import { recordFromUsage } from '../usage.js';
import type { StoredProfile } from './repo.js';

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;
export const aiConfigured = (): boolean => client !== null;

async function askJson(system: string, user: string, maxTokens = 700): Promise<Record<string, unknown> | null> {
  if (!client) return null;
  try {
    const message = await client.messages.create({
      model: env.anthropicModel,
      max_tokens: maxTokens,
      // Short, deterministic tasks: extended thinking would eat the budget.
      thinking: { type: 'disabled' },
      system,
      messages: [{ role: 'user', content: user }],
    });
    recordFromUsage('sales_followup', env.anthropicModel, message.usage);
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end < start) return null;
    return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch (err) {
    console.warn('[keepwarm] AI call failed:', (err as Error).message);
    return null;
  }
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.trim() : fallback);
const first = (name: string): string => name.trim().split(/[\s&]+/)[0] || name;

// ─── Setup: play back what the AI understood of the rep's business ──────────
export async function understandBusiness(about: string, company: string): Promise<KwUnderstood> {
  const out = await askJson(
    'You help a salesperson set up an assistant that drafts their follow-up texts. Read how they describe their business ' +
      'and play back what you understood, in plain, short Australian English (each value one sentence, max 20 words). ' +
      'Only use what they said or what clearly follows from it. Reply with JSON only: ' +
      '{"sells": "...", "clients": "...", "howTheyBuy": "...", "reasonsToText": "..."} where reasonsToText lists 3-4 natural, ' +
      'non-pushy reasons this kind of business could text a client (comma separated).',
    `Company: ${company}\nTheir description:\n${about}`,
    400,
  );
  if (out && str(out.sells)) {
    return { sells: str(out.sells), clients: str(out.clients), howTheyBuy: str(out.howTheyBuy), reasonsToText: str(out.reasonsToText) };
  }
  return {
    sells: about.split(/[.!?]/)[0]?.trim() || 'What you described',
    clients: 'The people you meet and quote',
    howTheyBuy: 'Over a few weeks, so staying in touch matters',
    reasonsToText: 'A quote that has gone quiet, a promise you made, a personal milestone',
  };
}

// ─── Voice note → sorted notes + a suggested rhythm ─────────────────────────
export interface ExtractResult {
  notes: { cat: KwNoteCat; text: string }[];
  stage: string;
  suggestion: { cadenceDays: number; mix: KwMix; why: string };
}

export async function extractNotes(transcript: string, profile: StoredProfile, clientName: string): Promise<ExtractResult> {
  const out = await askJson(
    `You turn a salesperson's spoken notes after a client meeting into short notes they will use for follow-up texts.\n` +
      `The salesperson: ${profile.displayName} at ${profile.company}. Their business: ${profile.understood?.sells ?? profile.about}\n` +
      `Sort facts into these categories:\n` +
      `- want: what the client is interested in\n- situation: their circumstances (house, bill, timing, constraints)\n` +
      `- decides: what will decide it (who else is involved, competing quotes, money worries)\n` +
      `- personal: human details (family, hobbies, events, plans) — ALWAYS keep these, they make friendly texts feel human\n` +
      `- promised: anything the salesperson promised to do, with the timing\n` +
      `Rules: each note under 12 words, plain words, no invented facts, skip filler. Also give a short stage label ` +
      `(e.g. "Site visit done", "Quote sent", "Customer") and suggest a follow-up rhythm: cadenceDays one of 7, 14, 30, 90; ` +
      `mix one of business, friendly, mix; and why (one short sentence addressed to the salesperson, e.g. "Quote is fresh and another quote lands Friday, so weekly keeps you in the running.").\n` +
      `Reply with JSON only: {"notes":[{"cat":"want","text":"..."}],"stage":"...","suggestion":{"cadenceDays":14,"mix":"mix","why":"..."}}`,
    `Client: ${clientName}\nWhat the salesperson said:\n${transcript}`,
    900,
  );
  const notes: { cat: KwNoteCat; text: string }[] = [];
  if (out && Array.isArray(out.notes)) {
    for (const n of out.notes as Record<string, unknown>[]) {
      const cat = str(n?.cat) as KwNoteCat;
      const text = str(n?.text);
      if (text && KW_NOTE_CATS.includes(cat)) notes.push({ cat, text });
    }
  }
  if (!notes.length) {
    // Offline: keep each sentence as a note so nothing the rep said is lost.
    for (const s of transcript.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 3).slice(0, 10)) {
      notes.push({ cat: 'situation', text: s.replace(/[.!?]$/, '') });
    }
  }
  const sug = (out?.suggestion ?? {}) as Record<string, unknown>;
  const cad = Number(sug.cadenceDays);
  const mix = str(sug.mix) as KwMix;
  return {
    notes,
    stage: str(out?.stage),
    suggestion: {
      cadenceDays: [7, 14, 30, 90].includes(cad) ? cad : 14,
      mix: mix === 'business' || mix === 'friendly' || mix === 'mix' ? mix : 'mix',
      why: str(sug.why, 'Fortnightly keeps you front of mind without crowding them while they decide.'),
    },
  };
}

// ─── Drafting a text ─────────────────────────────────────────────────────────
const TONE_GUIDE: Record<StoredProfile['tone'], string> = {
  relaxed: 'Relaxed and casual, like texting someone you get on with ("Hey Priya, Sam here.", "Sing out if…").',
  friendly: 'Friendly and professional ("Hi Priya, Sam from TSBA.", "Happy to walk you through it.").',
  direct: 'Straight to the point. Short sentences, one clear question.',
};

// Friendly check-ins must never sell. A cheap backstop on top of the prompt.
const SALESY = /\b(quote|quot(ed|ing)|pric(e|es|ing)|proposal|discount|offer|deal|special|limited|rebate|payback|kw\b|kilowatt|battery|batteries|sign up|book (a|an|in)|save money|savings)\b/i;
const BANNED = /(hope this (message )?finds you|valued customer|don'?t miss|act now|limited time|click here|https?:\/\/)/i;

export interface DraftInput {
  profile: StoredProfile;
  client: { name: string; stage: string; notes: KwNote[] };
  thread: { direction: 'out' | 'in'; body: string; at: string }[];
  type: KwTextType;
  kind: KwMessageKind;
  instruction?: string;
  shorter?: boolean;
  avoid?: string;
}

export interface DraftOutput {
  text: string;
  usedNotes: string[];
}

function draftSystem(p: StoredProfile): string {
  return [
    `You write SMS texts that ${p.displayName}, a salesperson at ${p.company}, sends to their own clients. You write AS ${p.displayName}, in first person. The client must feel it came from ${p.displayName}, never from software. Never mention AI, an assistant or automation.`,
    `About the business: ${p.understood ? `${p.understood.sells}. Clients: ${p.understood.clients}. ${p.understood.howTheyBuy}.` : p.about}`,
    `Tone: ${TONE_GUIDE[p.tone]}`,
    `Australian English. Sound like a real Aussie rep texting from their phone.`,
    `Length: one SMS (160 characters) is ideal. Never more than 300 characters.`,
    `Sign off with "${p.signOff}" at the end, unless the opening already says "${p.signOff} from ${p.company}" or "${p.signOff} here", in which case the sign-off is optional.`,
    `Use something REAL and specific from the notes (a name, an event, a worry, a promise). Never invent facts, figures, prices, dates or promises that are not in the notes, the conversation or the salesperson's instruction.`,
    `No marketing language, no emoji, no exclamation-mark spam, no links, no "I hope this finds you well", no "Dear". End with an easy next step or no ask at all. Never pushy.`,
    `Reply with JSON only: {"text": "...", "usedNotes": ["<ids of the notes you drew on>"]}`,
  ].join('\n');
}

function kindGuide(input: DraftInput): string {
  const f = first(input.client.name);
  const typeRule =
    input.type === 'friendly'
      ? `This is a FRIENDLY CHECK-IN. It must NOT sell: do not mention the quote, prices, products, the proposal, rebates, savings, meetings or any business. Draw on the PERSONAL notes (family, events, hobbies, plans) and ask after them warmly. If there are no personal notes, keep it a simple, genuine hello.`
      : `This is a BUSINESS FOLLOW-UP. Move the deal forward gently: pick up where things were left (what decides it, a promise made, a worry) and offer one easy next step.`;
  switch (input.kind) {
    case 'reply':
      return `${f} has replied (see the conversation). Write ${input.profile.displayName}'s answer to their latest message. Answer what they actually said first. Keep any commitment modest and realistic; ${input.profile.displayName} will check it before sending.`;
    case 'new':
      return `This is the first text after today's meeting with ${f}, while it's fresh: thank them for their time and mention one real detail. ${input.type === 'business' ? 'If something was promised, say when it is coming.' : ''}\n${typeRule}`;
    default:
      return typeRule;
  }
}

function offlineDraft(input: DraftInput): DraftOutput {
  const f = first(input.client.name);
  const { signOff, company } = input.profile;
  const personal = input.client.notes.find((n) => n.cat === 'personal');
  const decides = input.client.notes.find((n) => n.cat === 'decides' || n.cat === 'promised');
  if (input.instruction) {
    return { text: `Hi ${f}, ${signOff} here. ${input.instruction.trim().replace(/[.?!]*$/, '.')} ${signOff}`.slice(0, 300), usedNotes: [] };
  }
  if (input.kind === 'reply') {
    return { text: `Thanks ${f}, appreciate you getting back to me. I'll sort that and come back to you shortly. ${signOff}`, usedNotes: [] };
  }
  if (input.type === 'friendly') {
    return personal
      ? { text: `Hi ${f}, ${signOff} here. Was thinking of you, how did things go with ${personal.text.charAt(0).toLowerCase()}${personal.text.slice(1)}?`, usedNotes: [personal.id] }
      : { text: `Hi ${f}, ${signOff} here. No agenda today, just checking in to see how you're going.`, usedNotes: [] };
  }
  return decides
    ? { text: `Hi ${f}, ${signOff} from ${company}. Just following up, last time we spoke: ${decides.text.charAt(0).toLowerCase()}${decides.text.slice(1)}. Anything I can help with?`, usedNotes: [decides.id] }
    : { text: `Hi ${f}, ${signOff} from ${company}. Just checking in to see where things are at your end. Anything I can help move along?`, usedNotes: [] };
}

export async function draftText(input: DraftInput): Promise<DraftOutput> {
  const notes = input.client.notes.map((n) => `- [${n.id}] (${n.cat}) ${n.text}`).join('\n') || '(no notes yet)';
  const thread = input.thread.slice(-6).map((m) => `${m.direction === 'out' ? input.profile.displayName : first(input.client.name)}: ${m.body}`).join('\n');
  const asks = [
    kindGuide(input),
    input.instruction ? `The salesperson told you what to say: "${input.instruction}". Follow it closely; it overrides the defaults above (but never the rules about honesty and not selling in a friendly check-in).` : '',
    input.shorter ? 'Make it SHORT: under 100 characters.' : '',
    input.avoid ? `Write a clearly different version from this one: "${input.avoid}"` : '',
  ].filter(Boolean).join('\n');
  const user =
    `Client: ${input.client.name}${input.client.stage ? ` (${input.client.stage})` : ''}\nNotes:\n${notes}\n` +
    (thread ? `\nConversation so far (oldest first):\n${thread}\n` : '') +
    `\n${asks}`;

  const parse = (out: Record<string, unknown> | null): DraftOutput | null => {
    const text = str(out?.text).replace(/^["“]|["”]$/g, '');
    if (!text) return null;
    const ids = new Set(input.client.notes.map((n) => n.id));
    const used = Array.isArray(out?.usedNotes) ? (out!.usedNotes as unknown[]).filter((x): x is string => typeof x === 'string' && ids.has(x)) : [];
    return { text, usedNotes: used };
  };

  let draft = parse(await askJson(draftSystem(input.profile), user));
  if (!draft) return offlineDraft(input);

  // Guard: retry once if it breaks a rule the prompt asked for.
  const problems: string[] = [];
  if (input.type === 'friendly' && input.kind !== 'reply' && SALESY.test(draft.text) && !input.instruction) problems.push('it mentions business, but a friendly check-in must never sell');
  if (draft.text.length > (input.shorter ? 120 : 300)) problems.push(`it is ${draft.text.length} characters, too long`);
  if (BANNED.test(draft.text)) problems.push('it uses marketing language or a link');
  if (problems.length) {
    const retry = parse(await askJson(draftSystem(input.profile), `${user}\n\nYour previous attempt was rejected because ${problems.join(' and ')}:\n"${draft.text}"\nWrite it again, fixing that.`));
    if (retry) draft = retry;
  }
  return draft;
}

// ─── Scoreboard by voice: "Made 25 calls, 6 chats, booked two" ─────────────
export async function parseScore(sentence: string): Promise<Partial<Record<KwLoggedMetric, number>>> {
  const out = await askJson(
    'Extract sales activity counts from what a salesperson said about their day. Keys: calls (phone calls made), ' +
      'convos (conversations had), booked (meetings booked), attended (meetings attended), proposals (proposals sent), ' +
      'revenue (dollars of sales closed). Only include keys they mentioned. Numbers only. Reply with JSON only, e.g. {"calls": 25, "convos": 6}.',
    sentence,
    200,
  );
  const result: Partial<Record<KwLoggedMetric, number>> = {};
  const keys: KwLoggedMetric[] = ['calls', 'convos', 'booked', 'attended', 'proposals', 'revenue'];
  if (out) {
    for (const k of keys) {
      const v = Number(out[k]);
      if (Number.isFinite(v) && v > 0) result[k] = Math.round(v);
    }
    return result;
  }
  // Offline: "<number> <word>" pairs.
  const words: Record<string, KwLoggedMetric> = { call: 'calls', conversation: 'convos', chat: 'convos', booked: 'booked', meeting: 'booked', attended: 'attended', proposal: 'proposals' };
  for (const m of sentence.toLowerCase().matchAll(/(\d+)\s+(\w+)/g)) {
    const key = Object.keys(words).find((w) => m[2].startsWith(w));
    if (key) result[words[key]] = (result[words[key]] ?? 0) + Number(m[1]);
  }
  const rev = /\$\s?([\d,]+)/.exec(sentence);
  if (rev) result.revenue = Number(rev[1].replace(/,/g, ''));
  return result;
}

// ─── Pipeline agent: what does a client's reply mean for the deal? ──────────
export type ReplyIntent = 'booking' | 'accepted' | 'interested' | 'question' | 'not_now' | 'lost' | 'other';
export interface ReplySignal {
  intent: ReplyIntent;
  toStage: KwStage | null;
  /** Short quote from the reply that backs the call, so the rep can check it. */
  quote: string;
  /** How sure: 'clear' is safe to act on in assist mode; 'maybe' always asks. */
  confidence: 'clear' | 'maybe';
  summary: string;
}

const STAGE_FOR: Partial<Record<ReplyIntent, KwStage>> = {
  booking: 'meeting', accepted: 'won', interested: 'negotiating', question: 'negotiating', lost: 'lost',
};

export async function readReply(reply: string, ctx: { clientName: string; stage: KwStage; recent: string[] }): Promise<ReplySignal> {
  const out = await askJson(
    'You help a solar salesperson keep their pipeline accurate. Read the client\'s latest SMS reply and say what it means for the deal. ' +
      'intent is one of: booking (agrees to a meeting, call or site visit time), accepted (clearly says yes, go ahead, sign, deposit), ' +
      'interested (positive, wants to proceed or more info), question (asks about the quote/product/price/timing), ' +
      'not_now (later, busy, on hold, still thinking), lost (went with someone else, not going ahead, too expensive and done), other. ' +
      'confidence is "clear" only when the words leave no doubt, else "maybe". quote = the exact words (max 12) that show it. ' +
      'summary = one short sentence to the salesperson. Reply with JSON only: {"intent":"...","confidence":"...","quote":"...","summary":"..."}',
    `Client: ${ctx.clientName}\nDeal stage now: ${ctx.stage}\nEarlier texts (oldest first):\n${ctx.recent.join('\n') || '(none)'}\n\nTheir new reply:\n${reply}`,
    300,
  );
  const intents: ReplyIntent[] = ['booking', 'accepted', 'interested', 'question', 'not_now', 'lost', 'other'];
  let intent = str(out?.intent) as ReplyIntent;
  let confidence: 'clear' | 'maybe' = out?.confidence === 'clear' ? 'clear' : 'maybe';
  let quote = str(out?.quote).slice(0, 120);
  let summary = str(out?.summary);
  if (!out || !intents.includes(intent)) {
    // Offline: a few unmistakable phrases, everything else just "replied".
    const t = reply.toLowerCase();
    const hit = (re: RegExp) => re.exec(t)?.[0] ?? '';
    const rules: [ReplyIntent, RegExp][] = [
      ['accepted', /\b(go ahead|let'?s do it|we'?re in|sign(ed)? (it|the)|paid the deposit|happy to proceed)\b/],
      ['lost', /\b(went with (someone|another)|going with (someone|another)|not going ahead|no longer interested|decided against)\b/],
      ['booking', /\b(come (over|out|round)|see you (on|at)|works for (me|us)|book (it|me) in)\b/],
      ['not_now', /\b(not (right )?now|next (month|year)|on hold|too busy|later in the year)\b/],
      ['question', /\?/],
    ];
    intent = 'other';
    for (const [i, re] of rules) {
      const q = hit(re);
      if (q) { intent = i; quote = q; break; }
    }
    confidence = 'maybe';
    summary = '';
  }
  // Never move backwards automatically (a question at "Quote sent" is not a demotion to anything).
  const order: KwStage[] = ['lead', 'contacted', 'meeting', 'quoted', 'negotiating', 'won'];
  let toStage = STAGE_FOR[intent] ?? null;
  if (toStage && toStage !== 'lost' && order.indexOf(toStage) <= order.indexOf(ctx.stage)) toStage = null;
  if (ctx.stage === 'lead' && !toStage && intent !== 'lost') toStage = 'contacted';
  if (toStage === ctx.stage) toStage = null;
  return {
    intent,
    toStage,
    quote,
    confidence,
    summary: summary || `${first(ctx.clientName)} replied${intent !== 'other' ? ` (${intent.replace('_', ' ')})` : ''}.`,
  };
}

// ─── Auto-replies: may the agent answer this message by itself? ─────────────
// Only switched on when Sales settings → auto-replies is on. Two gates: a hard
// rule list here (cheap, can't be argued with) and the model's own judgement.
// Anything doubtful goes to the rep.
const ESCALATE: [RegExp, string][] = [
  [/\b(price|pricing|cost|costs|how much|\$\s?\d|quote|quoted|discount|deal|cheaper|finance|payment|deposit|rebate|stc|loan)\b/i, 'They asked about price, the quote or money'],
  [/\b(complain|complaint|unhappy|not happy|disappointed|angry|terrible|awful|rubbish|refund|cancel|lawyer|ombudsman|fair trading|accc)\b/i, 'They sound unhappy or want to cancel'],
  [/\b(call me|ring me|speak to (someone|a person|a human|you)|talk to (someone|a person|you)|is this (a bot|automated|ai)|are you (a bot|real|ai))\b/i, 'They want to talk to a person'],
  [/\b(contract|warranty claim|sign(ed)?|terms)\b/i, 'It’s about the contract or warranty'],
];

export interface AutoDecision {
  handle: boolean;
  /** Why it's the rep's call (when handle = false), or what the agent is doing. */
  reason: string;
  text: string;
}

export async function autoReplyDecision(input: Omit<DraftInput, 'type' | 'kind'>, latest: string): Promise<AutoDecision> {
  for (const [re, why] of ESCALATE) if (re.test(latest)) return { handle: false, reason: why, text: '' };
  if (!client) return { handle: false, reason: 'AI is not configured, so replies need you', text: '' };
  const notes = input.client.notes.map((n) => `- (${n.cat}) ${n.text}`).join('\n') || '(no notes)';
  const thread = input.thread.slice(-8).map((m) => `${m.direction === 'out' ? input.profile.displayName : first(input.client.name)}: ${m.body}`).join('\n');
  const system =
    draftSystem(input.profile).replace(/Reply with JSON only:.*$/m, '') +
    `\nYou are deciding whether ${input.profile.displayName} needs to answer this personally, or whether you can answer it now in their name.\n` +
    `You MAY answer only: thanks/acknowledgements, confirming or politely re-offering a time that was ALREADY agreed or proposed in the conversation, ` +
    `simple small talk, and simple factual questions fully answered by the business description or notes.\n` +
    `You MUST hand over (handle=false) for: anything about price, the quote, money, finance or rebates; complaints or frustration; requests for a call or a person; ` +
    `new commitments (dates, times, visits, documents) not already agreed; technical or product questions not fully answered by the notes; anything you are not sure about.\n` +
    `If you answer: one short SMS, max 200 characters, no new promises, no invented facts, and do NOT mention the quote, prices or money.\n` +
    `If the message needs no answer at all (e.g. a final "thanks" or "see you then" after things are settled), set handle=true and text="".\n` +
    `Reply with JSON only: {"handle": true|false, "reason": "<one short sentence for ${input.profile.displayName}>", "text": "<the SMS, or empty>"}`;
  const user = `Client: ${input.client.name}${input.client.stage ? ` (${input.client.stage})` : ''}\nNotes:\n${notes}\n\nConversation (oldest first):\n${thread}\n\nTheir latest message:\n${latest}`;
  const problem = (t: string) =>
    t.length > 240 ? 'it is too long' : BANNED.test(t) ? 'it uses marketing language or a link' : /\$\s?\d|\bquote\b|\bprice\b|\bcost\b/i.test(t) ? 'it mentions the quote or money' : '';

  let out = await askJson(system, user, 500);
  if (!out) return { handle: false, reason: 'The AI didn’t answer, so this needs you', text: '' };
  if (out.handle === true && str(out.text) && problem(str(out.text))) {
    // One retry with the reason, like the drafting guard.
    const why = problem(str(out.text));
    out = await askJson(system, `${user}\n\nYour previous answer was rejected because ${why}:\n"${str(out.text)}"\nTry again, or hand over.`, 500);
    if (!out) return { handle: false, reason: 'Needs your judgement', text: '' };
  }
  const text = str(out.text).replace(/^["“]|["”]$/g, '');
  const reason = str(out.reason);
  if (out.handle !== true) return { handle: false, reason: reason || 'Needs your judgement', text: '' };
  if (text && problem(text)) return { handle: false, reason: `My reply ${problem(text)}, so it’s better coming from you`, text: '' };
  return { handle: true, reason: reason || (text ? 'Routine reply' : 'Nothing needs answering'), text };
}

/** Has this conversation reached a natural end? (Used to offer a handback, never to force one.) */
export async function conversationEnded(thread: { direction: 'out' | 'in'; body: string }[], repName: string): Promise<{ ended: boolean; why: string }> {
  const last = thread.slice(-6);
  if (!last.length) return { ended: false, why: '' };
  const out = await askJson(
    'Decide if this SMS conversation between a salesperson and a client has reached a natural end: nothing is left unanswered, ' +
      'nobody is waiting on the other (e.g. "Thanks, see you Thursday" / "See you then"). Reply with JSON only: {"ended": true|false, "why": "<max 15 words>"}',
    last.map((m) => `${m.direction === 'out' ? repName : 'Client'}: ${m.body}`).join('\n'),
    120,
  );
  if (out) return { ended: out.ended === true, why: str(out.why) };
  // Offline: the last two messages are both sign-offs.
  const bye = /\b(thanks|thank you|cheers|see you|talk soon|no worries|sounds good|perfect|great)\b/i;
  const ended = last.length >= 2 && bye.test(last[last.length - 1].body) && bye.test(last[last.length - 2].body);
  return { ended, why: ended ? 'Both sides signed off' : '' };
}

/** One-line memory of a finished conversation, saved to the client's notes. */
export async function summariseConversation(thread: { direction: 'out' | 'in'; body: string }[], clientName: string): Promise<string> {
  if (!thread.length) return '';
  const out = await askJson(
    'Summarise this SMS conversation with a client as ONE note for the salesperson\'s file: what was asked, what was agreed, what happens next. ' +
      'Max 20 words, plain words, no invented facts. Reply with JSON only: {"note": "..."}',
    thread.slice(-20).map((m) => `${m.direction === 'out' ? 'Salesperson' : first(clientName)}: ${m.body}`).join('\n'),
    150,
  );
  return str(out?.note).slice(0, 200);
}
