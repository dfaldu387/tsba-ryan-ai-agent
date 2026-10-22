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

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A natural, spoken-style conversational turn (for the Voice Agent). Unlike
 * draftReply this keeps the whole dialogue as messages, replies in plain text,
 * and is steered entirely by the caller-supplied system prompt (which carries
 * the grounding rules + retrieved knowledge).
 */
export async function chatReply(
  system: string,
  turns: ChatTurn[],
  signal?: AbortSignal,
): Promise<string> {
  if (!client) throw new Error('ANTHROPIC_API_KEY is not set on the server');

  const message = await client.messages.create(
    {
      model: env.anthropicModel,
      max_tokens: 600,
      system,
      messages: turns.map((t) => ({ role: t.role, content: t.content })),
    },
    { signal },
  );

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (!text) throw new Error('Model returned an empty reply');
  return text;
}

/**
 * Extract text from a PDF using Claude's native document support — it reads the
 * pages as images, so it works on scanned/image-only PDFs and on files with a
 * broken font-encoding text layer that pdf-parse and Drive OCR can't handle.
 * Returns clean plain text. Caller decides whether to use it (compare quality).
 * Throws if no key is set, the PDF is too large, or the API rejects it.
 */
export async function extractPdfWithClaude(buffer: Buffer, signal?: AbortSignal): Promise<string> {
  if (!client) throw new Error('ANTHROPIC_API_KEY is not set on the server');

  const message = await client.messages.create(
    {
      model: env.anthropicModel,
      max_tokens: 8000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
            },
            {
              type: 'text',
              text:
                'Extract ALL readable text from this document exactly as written, in reading order. ' +
                'Include text that appears inside images, diagrams, logos and tables (render tables as ' +
                'plain text, one row per line, values separated by " | "). Preserve numbers, units and ' +
                'model codes precisely. Do NOT summarise, translate, explain, or add any commentary — ' +
                'output only the document’s own text content.',
            },
          ],
        },
      ],
    },
    { signal },
  );

  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
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
