import type { Draft, KnowledgeEntry } from '@tsba/shared';
import { embeddingProvider, entryEmbeddingText } from '../embeddings.js';
import { loadKnowledgeEntries } from '../knowledge-data.js';
import type { DraftStore, InsertDraftArgs, KnowledgeStore, Storage } from './types.js';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * In-memory knowledge store. Loads the JSON on startup and runs the same
 * retrieval strategy as the DB path (all rules + top-K manufacturer answers by
 * cosine similarity), with maker embeddings precomputed once. No database.
 */
export class MemoryKnowledgeStore implements KnowledgeStore {
  private rules: KnowledgeEntry[] = [];
  private makers: KnowledgeEntry[] = [];
  private makerVectors: number[][] = [];

  async init(): Promise<void> {
    const entries = loadKnowledgeEntries();
    this.rules = entries.filter((e) => e.kind === 'rule');
    this.makers = entries.filter((e) => e.kind === 'maker');
    this.makerVectors = await embeddingProvider.embed(this.makers.map((e) => entryEmbeddingText(e)));
  }

  async retrieve(question: string, topK: number): Promise<KnowledgeEntry[]> {
    let top: KnowledgeEntry[] = [];
    try {
      const [qvec] = await embeddingProvider.embed([question]);
      top = this.makers
        .map((e, i) => ({ e, score: cosine(qvec, this.makerVectors[i]) }))
        .sort((x, y) => y.score - x.score)
        .slice(0, topK)
        .map((x) => x.e);
    } catch {
      // Lexical fallback if the embedding provider is unavailable.
      const terms = (question.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 2);
      top = this.makers
        .filter((e) => {
          const hay = `${e.brand} ${e.model} ${e.title} ${e.text}`.toLowerCase();
          return terms.some((t) => hay.includes(t));
        })
        .slice(0, topK);
    }
    return [...this.rules, ...top];
  }
}

/** In-memory approval queue. Lost on restart — fine for the preview. */
export class MemoryDraftStore implements DraftStore {
  private rows: Draft[] = [];
  private nextId = 1;

  async insert(args: InsertDraftArgs): Promise<Draft> {
    const now = new Date().toISOString();
    const draft: Draft = {
      id: this.nextId++,
      question: args.question,
      audience: args.audience,
      channel: args.channel,
      outcome: args.result.outcome,
      reply: args.result.reply,
      reply_original: args.result.reply,
      sources: args.sources,
      note_for_ryan: args.result.note_for_ryan,
      team_handover: args.result.team_handover,
      status: 'pending',
      edited: false,
      created_at: now,
      decided_at: null,
    };
    this.rows.push(draft);
    return draft;
  }

  async list(): Promise<Draft[]> {
    return this.rows.slice();
  }

  async get(id: number): Promise<Draft | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async update(id: number, action: 'approve' | 'reject' | 'edit', text?: string): Promise<Draft | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;

    if (action === 'edit') {
      const newText = (text ?? '').trim();
      row.reply = newText;
      row.edited = newText !== row.reply_original.trim();
    } else if (action === 'approve') {
      if (text !== undefined) row.reply = text.trim();
      row.edited = row.edited || row.reply.trim() !== row.reply_original.trim();
      row.status = row.outcome === 'handover' ? 'team' : 'sent';
      row.decided_at = new Date().toISOString();
    } else {
      row.status = 'rejected';
      row.decided_at = new Date().toISOString();
    }
    return row;
  }
}

export async function createMemoryStorage(): Promise<Storage> {
  const knowledge = new MemoryKnowledgeStore();
  await knowledge.init();
  return { knowledge, drafts: new MemoryDraftStore(), usesPostgres: false };
}
