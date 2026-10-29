import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { env } from './env.js';

// ─── AI token-usage tracking ─────────────────────────────────────────────────
// Each Claude call appends one line to an append-only JSONL log. It's backend-
// agnostic (works in both memory and postgres modes), survives restarts, and is
// trivial to filter by date. Recording is strictly best-effort: a logging
// failure must never break or slow an actual response.

export type UsageActivity =
  | 'draft' // Ask-the-agent draft reply
  | 'voice_chat' // Voice agent conversational turn
  | 'followups' // follow-up suggestions
  | 'starters' // opening suggestions
  | 'pdf_extract'; // Claude PDF text extraction (ingest/OCR)

export const USAGE_ACTIVITY_LABELS: Record<UsageActivity, string> = {
  draft: 'Draft reply',
  voice_chat: 'Voice chat',
  followups: 'Follow-up suggestions',
  starters: 'Opening suggestions',
  pdf_extract: 'PDF extraction',
};

export interface UsageEvent {
  ts: string; // ISO timestamp
  activity: UsageActivity;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/** The shape of the `usage` object on an Anthropic message response. */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

let dirReady = false;
async function ensureDir(): Promise<void> {
  if (dirReady) return;
  await mkdir(dirname(env.usageLogFile), { recursive: true }).catch(() => {});
  dirReady = true;
}

/** Append one usage event to the log (fire-and-forget; never throws). */
export async function recordUsage(ev: UsageEvent): Promise<void> {
  try {
    await ensureDir();
    await appendFile(env.usageLogFile, `${JSON.stringify(ev)}\n`, 'utf8');
  } catch {
    /* tracking must never break a response */
  }
}

/**
 * Record usage from an Anthropic message response. Call-site friendly: pass the
 * activity, model and `message.usage`. Fire-and-forget — do not await.
 */
export function recordFromUsage(
  activity: UsageActivity,
  model: string,
  usage: AnthropicUsage | null | undefined,
): void {
  if (!usage) return;
  void recordUsage({
    ts: new Date().toISOString(),
    activity,
    model,
    input_tokens: Number(usage.input_tokens ?? 0),
    output_tokens: Number(usage.output_tokens ?? 0),
    ...(usage.cache_read_input_tokens ? { cache_read_tokens: Number(usage.cache_read_input_tokens) } : {}),
    ...(usage.cache_creation_input_tokens ? { cache_write_tokens: Number(usage.cache_creation_input_tokens) } : {}),
  });
}

export interface UsageTotals {
  requests: number;
  input: number;
  output: number;
  total: number;
  cacheRead: number; // input tokens served from the prompt cache (~10% cost)
  cacheWrite: number; // tokens written to the cache (~125% cost, once)
  cost: number; // estimated USD spend
}

// USD per 1,000,000 tokens, by model. Cache reads are ~10% of input; cache
// writes ~125%. Prices as of the Claude API reference; unknown models fall back
// to the default (Sonnet) rate so a cost is still shown.
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
const DEFAULT_PRICING = PRICING['claude-sonnet-5-5'];

/** Estimated USD cost of one usage event, from its model's per-token rates. */
export function costOf(ev: UsageEvent): number {
  const p = PRICING[ev.model] ?? DEFAULT_PRICING;
  return (
    (ev.input_tokens * p.input +
      ev.output_tokens * p.output +
      (ev.cache_read_tokens ?? 0) * p.cacheRead +
      (ev.cache_write_tokens ?? 0) * p.cacheWrite) /
    1_000_000
  );
}

export interface UsageDayRow extends UsageTotals {
  date: string; // YYYY-MM-DD
}

export interface UsageReport {
  from: string | null;
  to: string | null;
  totals: UsageTotals;
  byActivity: { activity: UsageActivity; label: string; totals: UsageTotals }[];
  byDay: UsageDayRow[];
  events: (UsageEvent & { total: number; cost: number })[];
}

const EMPTY_TOTALS = (): UsageTotals => ({
  requests: 0,
  input: 0,
  output: 0,
  total: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

function addInto(t: UsageTotals, ev: UsageEvent): void {
  t.requests += 1;
  t.input += ev.input_tokens;
  t.output += ev.output_tokens;
  t.total += ev.input_tokens + ev.output_tokens;
  t.cacheRead += ev.cache_read_tokens ?? 0;
  t.cacheWrite += ev.cache_write_tokens ?? 0;
  t.cost += costOf(ev);
}

/**
 * Read the usage log and return aggregates for an optional inclusive date range
 * (YYYY-MM-DD, compared against the UTC date of each event). `events` is capped
 * to the most recent `limit` matching rows (newest first).
 */
export async function queryUsage(
  opts: { from?: string | null; to?: string | null; limit?: number } = {},
): Promise<UsageReport> {
  const from = opts.from || null;
  const to = opts.to || null;
  const limit = opts.limit ?? 500;

  let raw = '';
  try {
    raw = await readFile(env.usageLogFile, 'utf8');
  } catch {
    raw = ''; // no log yet → empty report
  }

  const matched: UsageEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev: UsageEvent;
    try {
      ev = JSON.parse(line) as UsageEvent;
    } catch {
      continue; // skip a corrupt line
    }
    const day = ev.ts.slice(0, 10); // ISO date; lexical compare is safe
    if (from && day < from) continue;
    if (to && day > to) continue;
    matched.push(ev);
  }

  const totals = EMPTY_TOTALS();
  const byActivityMap = new Map<UsageActivity, UsageTotals>();
  const byDayMap = new Map<string, UsageTotals>();

  for (const ev of matched) {
    addInto(totals, ev);

    let a = byActivityMap.get(ev.activity);
    if (!a) byActivityMap.set(ev.activity, (a = EMPTY_TOTALS()));
    addInto(a, ev);

    const day = ev.ts.slice(0, 10);
    let d = byDayMap.get(day);
    if (!d) byDayMap.set(day, (d = EMPTY_TOTALS()));
    addInto(d, ev);
  }

  const byActivity = [...byActivityMap.entries()]
    .map(([activity, t]) => ({ activity, label: USAGE_ACTIVITY_LABELS[activity] ?? activity, totals: t }))
    .sort((x, y) => y.totals.total - x.totals.total);

  const byDay: UsageDayRow[] = [...byDayMap.entries()]
    .map(([date, t]) => ({ date, ...t }))
    .sort((x, y) => (x.date < y.date ? 1 : -1)); // newest day first

  const events = matched
    .slice(-limit)
    .reverse()
    .map((ev) => ({ ...ev, total: ev.input_tokens + ev.output_tokens, cost: costOf(ev) }));

  return { from, to, totals, byActivity, byDay, events };
}
