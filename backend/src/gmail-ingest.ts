import type {
  GmailScanResult,
  IngestResult,
  IngestedDocument,
  KnowledgeEntry,
} from '@tsba/shared';
import { getLabelName, getMessage, listMessageIds, type GmailMessage } from './google-gmail.js';
import { chunkText } from './extract.js';
import { getStorage } from './storage.js';
import { invalidateAnswerCache } from './answer-cache.js';

// Scans a Gmail label into the knowledge base: each message's text is chunked
// and stored as 'maker' knowledge with ids `gmail:<messageId>:<n>`. The document
// id is `gmail:<messageId>` so its chunks share that id as a prefix.

const MAX_CHUNKS = 200; // per message
const DEFAULT_MAX_MESSAGES = 200;

export function docId(messageId: string): string {
  return `gmail:${messageId}`;
}

function chunkPrefix(messageId: string): string {
  return `${docId(messageId)}:`;
}

function buildEntries(msg: GmailMessage, chunks: string[]): KnowledgeEntry[] {
  const total = chunks.length;
  const header = `${msg.subject} — from ${msg.from}`;
  return chunks.map((text, i) => ({
    id: `${chunkPrefix(msg.id)}${i}`,
    kind: 'maker',
    brand: 'TSBA Email',
    model: '',
    topic: msg.subject.slice(0, 120),
    title: total > 1 ? `${msg.subject} — part ${i + 1}/${total}` : msg.subject,
    text: `${header}\n\n${text}`,
    source: `Gmail — ${msg.subject} (${msg.webUrl})`,
    confidence: 'medium',
  }));
}

async function ingestMessage(messageId: string): Promise<IngestResult> {
  const storage = await getStorage();
  let name = messageId;
  try {
    const msg = await getMessage(messageId);
    name = msg.subject;

    const recordDoc = (status: IngestedDocument['status'], chunkCount: number) =>
      storage.documents.upsert({
        id: docId(messageId),
        source: 'gmail',
        title: msg.subject,
        mime_type: 'message/rfc822',
        web_url: msg.webUrl,
        chunk_count: chunkCount,
        byte_size: msg.text.length,
        status,
        ingested_at: new Date().toISOString(),
      });

    const chunks = chunkText(msg.text).slice(0, MAX_CHUNKS);
    if (!chunks.length) {
      await recordDoc('skipped', 0);
      return { fileId: docId(messageId), name, status: 'skipped', chunks: 0, reason: 'no extractable text' };
    }

    await storage.knowledge.removeByPrefix(chunkPrefix(messageId));
    await storage.knowledge.add(buildEntries(msg, chunks));
    await recordDoc('ingested', chunks.length);
    return { fileId: docId(messageId), name, status: 'ingested', chunks: chunks.length };
  } catch (err) {
    return { fileId: docId(messageId), name, status: 'failed', chunks: 0, reason: (err as Error).message };
  }
}

/** Scan up to `max` messages under a label into the knowledge base. */
export async function scanLabel(labelId: string, max = DEFAULT_MAX_MESSAGES): Promise<GmailScanResult> {
  const labelName = await getLabelName(labelId);
  const ids = await listMessageIds(labelId, Math.max(1, Math.min(max, 1000)));

  const results: IngestResult[] = [];
  for (const id of ids) results.push(await ingestMessage(id));
  if (ids.length) invalidateAnswerCache(); // KB changed → drop stale answers

  return {
    labelId,
    labelName,
    messagesFound: ids.length,
    ingested: results.filter((r) => r.status === 'ingested').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  };
}
