import Anthropic from '@anthropic-ai/sdk';
import { isOutcome, type DraftResult } from '@tsba/shared';
import { env } from './env.js';
import { recordFromUsage } from './usage.js';

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
  // String for a plain text turn, or content blocks when the turn carries
  // attachments (images / PDFs) alongside the text.
  content: string | Anthropic.Messages.ContentBlockParam[];
}

/** A user-supplied attachment to include in a chat turn (image or PDF). */
export interface ChatAttachment {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf';
  /** Base64-encoded file bytes (no data: prefix). */
  data: string;
}

/** Build a user content array from text + attachments for the Messages API. */
export function buildUserContent(text: string, attachments: ChatAttachment[]): Anthropic.Messages.ContentBlockParam[] {
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];
  for (const a of attachments) {
    if (a.mediaType === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
    } else {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } });
    }
  }
  if (text) blocks.push({ type: 'text', text });
  return blocks;
}

/**
 * A natural, spoken-style conversational turn (for the Voice Agent). Unlike
 * draftReply this keeps the whole dialogue as messages, replies in plain text,
 * and is steered entirely by the caller-supplied system prompt (which carries
 * the grounding rules + retrieved knowledge).
 */
export async function chatReply(
  system: { stable: string; volatile: string },
  turns: ChatTurn[],
  signal?: AbortSignal,
): Promise<string> {
  if (!client) throw new Error('ANTHROPIC_API_KEY is not set on the server');

  const message = await client.messages.create(
    {
      model: env.anthropicModel,
      // Headroom so a complete answer with a short step list is never cut off
      // mid-sentence (replies are still kept brief by the prompt).
      max_tokens: 800,
      // Cache the stable behaviour block; the volatile KNOWLEDGE follows it and
      // is not cached. Same content as before — just a cache breakpoint between.
      system: [
        { type: 'text', text: system.stable, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: system.volatile },
      ],
      messages: turns.map((t) => ({ role: t.role, content: t.content })),
    },
    { signal },
  );
  recordFromUsage('voice_chat', env.anthropicModel, message.usage);

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
  recordFromUsage('pdf_extract', env.anthropicModel, message.usage);

  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Generate up to 3 short, contextual follow-up questions a user might ask next,
 * based on the question just asked, the answer given, and what's in the knowledge.
 * Best-effort: returns [] on any failure so the chat never breaks over suggestions.
 */
export async function suggestFollowups(
  question: string,
  answer: string,
  context: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!client) return [];
  try {
    const message = await client.messages.create(
      {
        model: env.anthropicModel,
        max_tokens: 200,
        system:
          'You generate up to 3 short tappable chips for a solar inverter technical-support chat. ' +
          'Output ONLY a JSON array of exactly 3 short strings (each 3–9 words), nothing else. ' +
          'Plain text, no numbering, no quotes inside the strings.\n' +
          'FIRST decide which kind to produce from the ANSWER:\n' +
          '- If the answer is ASKING THE USER TO CLARIFY or choose (it asks which model/brand/variant ' +
          'they have, or needs a specific detail before it can answer), produce REQUIREMENT-GATHERING ' +
          'chips: concrete options the user can tap to supply that detail, phrased as the USER\'S OWN ' +
          'reply (first person). Draw real model/brand names from the products/documents listed below ' +
          '(e.g. "I have the Deye SUN-8K-SG05LP1-AU", "It\'s a GoodWe GW5000", "Mine is a SOFAR inverter"). ' +
          'Prefer the exact models present in the available knowledge; do not invent models.\n' +
          '- OTHERWISE, produce 3 natural NEXT follow-up QUESTIONS that build on the product/brand just ' +
          'discussed and the available knowledge (efficiency, MPPT count, backup, warranty, IP rating, settings). ' +
          'Do not repeat the question already asked.',
        messages: [
          {
            role: 'user',
            content: `Question just asked: ${question}\n\nAnswer given: ${answer}\n\nProducts/documents available in the knowledge base right now:\n${context || '(general)'}\n\nReturn the JSON array of 3 chips (requirement-gathering options if the answer is asking the user to clarify, otherwise follow-up questions).`,
          },
        ],
      },
      { signal },
    );
    recordFromUsage('followups', env.anthropicModel, message.usage);
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const match = text.match(/\[[\s\S]*\]/);
    const arr: unknown = match ? JSON.parse(match[0]) : [];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim().slice(0, 90))
      .slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * Generate opening suggestion questions for an empty chat, grounded in the
 * products actually present in the knowledge base. Best-effort → [] on failure.
 */
export async function suggestStarters(context: string, signal?: AbortSignal): Promise<string[]> {
  if (!client) return [];
  try {
    const message = await client.messages.create(
      {
        model: env.anthropicModel,
        max_tokens: 220,
        system:
          'You suggest good OPENING questions for a solar inverter technical-support chat. ' +
          'Output ONLY a JSON array of exactly 4 short questions (each 4–9 words), nothing else. ' +
          'Base them on the actual products listed below so they reference real brands/models in stock. ' +
          'Vary the topics (features, efficiency, backup, warranty, compatibility). Plain text, no quotes inside the strings.',
        messages: [
          {
            role: 'user',
            content: `Products available in the knowledge base:\n${context || '(solar inverters and batteries)'}\n\nReturn a JSON array of 4 opening questions.`,
          },
        ],
      },
      { signal },
    );
    recordFromUsage('starters', env.anthropicModel, message.usage);
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const match = text.match(/\[[\s\S]*\]/);
    const arr: unknown = match ? JSON.parse(match[0]) : [];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim().slice(0, 90))
      .slice(0, 4);
  } catch {
    return [];
  }
}

export async function draftReply(
  prompt: { stable: string; volatile: string },
  signal?: AbortSignal,
): Promise<DraftResult> {
  if (!client) throw new Error('ANTHROPIC_API_KEY is not set on the server');

  const message = await client.messages.create(
    {
      model: env.anthropicModel,
      max_tokens: 1200,
      // The stable prefix (instructions + verified rules) is cached; the
      // volatile suffix (ask context + retrieved datasheets + question) is not.
      // Identical content to the old single string — only a cache breakpoint
      // is inserted, so repeat calls reuse the prefix at ~10% cost.
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt.stable, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: prompt.volatile },
          ],
        },
      ],
    },
    { signal },
  );
  recordFromUsage('draft', env.anthropicModel, message.usage);

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return coerceResult(extractJson(text));
}
