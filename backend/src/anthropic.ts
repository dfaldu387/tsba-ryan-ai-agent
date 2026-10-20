import Anthropic from '@anthropic-ai/sdk';
import { isOutcome, type DraftResult } from '@tsba/shared';
import { env } from './env.js';

const client = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;

export function anthropicConfigured(): boolean {
  return client !== null;
}

/** Pull the first JSON object out of a model response that may wrap it in prose/fences. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('No JSON object in model response');
  return JSON.parse(candidate.slice(start, end + 1));
}

function coerceResult(raw: unknown): DraftResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('Model response was not an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.reply !== 'string') throw new Error('Model response missing "reply"');

  const outcome = isOutcome(r.outcome) ? r.outcome : 'answer';
  const sources = Array.isArray(r.sources) ? r.sources.filter((s): s is string => typeof s === 'string') : [];
  const note = typeof r.note_for_ryan === 'string' ? r.note_for_ryan : '';

  let handover: DraftResult['team_handover'] = null;
  if (outcome === 'handover' && r.team_handover && typeof r.team_handover === 'object') {
    const th = r.team_handover as Record<string, unknown>;
    handover = {
      summary: typeof th.summary === 'string' ? th.summary : '',
      needed: Array.isArray(th.needed) ? th.needed.filter((n): n is string => typeof n === 'string') : [],
    };
  }

  return { outcome, reply: r.reply.trim(), sources, note_for_ryan: note, team_handover: handover };
}

export async function draftReply(prompt: string, signal?: AbortSignal): Promise<DraftResult> {
  if (!client) throw new Error('ANTHROPIC_API_KEY is not set on the server');

  const message = await client.messages.create(
    {
      model: env.anthropicModel,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    },
    { signal },
  );

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return coerceResult(extractJson(text));
}
