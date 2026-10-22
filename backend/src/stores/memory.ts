import { randomUUID } from 'node:crypto';
import type {
  ConnectionProvider,
  Draft,
  DraftDelivery,
  DriveFolderSource,
  IngestedDocument,
  KnowledgeEntry,
} from '@tsba/shared';
import { embeddingProvider, entryEmbeddingText } from '../embeddings.js';
import { brandMatches } from '../brand.js';
import { loadKnowledgeEntries } from '../knowledge-data.js';
import type {
  ConnectionStore,
  DocumentStore,
  DraftStore,
  FolderSourceStore,
  InsertDraftArgs,
  KnowledgeStore,
  NewUser,
  StoredConnection,
  StoredUser,
  Storage,
  UserStore,
  UserUpdate,
} from './types.js';

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

// Added to a maker entry's cosine score when its brand matches the detected brand
// (or it's brand-agnostic). Kept in sync with BRAND_BONUS in retrieval.ts.
const BRAND_BONUS = 0.15;

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

  async retrieve(question: string, topK: number, brand?: string | null): Promise<KnowledgeEntry[]> {
    let top: KnowledgeEntry[] = [];
    try {
      const [qvec] = await embeddingProvider.embed([question]);
      top = this.makers
        .map((e, i) => ({
          e,
          // Brand-aware: boost the detected brand (and brand-agnostic) entries.
          score: cosine(qvec, this.makerVectors[i]) + (brandMatches(e.brand, brand) ? BRAND_BONUS : 0),
        }))
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
        // Brand-aware: surface matching-brand entries first.
        .sort((a, b) => Number(brandMatches(b.brand, brand)) - Number(brandMatches(a.brand, brand)))
        .slice(0, topK);
    }
    return [...this.rules, ...top];
  }

  async add(entries: KnowledgeEntry[]): Promise<void> {
    if (!entries.length) return;
    // Replace any existing entries with the same id (re-ingest), then append.
    const incoming = new Set(entries.map((e) => e.id));
    for (let i = this.makers.length - 1; i >= 0; i--) {
      if (incoming.has(this.makers[i].id)) {
        this.makers.splice(i, 1);
        this.makerVectors.splice(i, 1);
      }
    }
    const vectors = await embeddingProvider.embed(entries.map((e) => entryEmbeddingText(e)));
    entries.forEach((e, i) => {
      this.makers.push(e);
      this.makerVectors.push(vectors[i]);
    });
  }

  async removeByPrefix(idPrefix: string): Promise<void> {
    for (let i = this.makers.length - 1; i >= 0; i--) {
      if (this.makers[i].id.startsWith(idPrefix)) {
        this.makers.splice(i, 1);
        this.makerVectors.splice(i, 1);
      }
    }
  }

  async getTextByPrefix(idPrefix: string): Promise<string> {
    return this.makers
      .filter((m) => m.id.startsWith(idPrefix))
      .map((m) => m.text)
      .join('\n');
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
      recipient: args.recipient ?? null,
      delivery: null,
      created_at: now,
      decided_at: null,
    };
    this.rows.push(draft);
    return draft;
  }

  async recordDelivery(id: number, delivery: DraftDelivery): Promise<Draft | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    row.delivery = delivery;
    return row;
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

/** In-memory connection store. Tokens are lost on restart — fine for the preview. */
export class MemoryConnectionStore implements ConnectionStore {
  private rows = new Map<ConnectionProvider, StoredConnection>();

  async get(provider: ConnectionProvider): Promise<StoredConnection | null> {
    return this.rows.get(provider) ?? null;
  }

  async list(): Promise<StoredConnection[]> {
    return [...this.rows.values()];
  }

  async upsert(conn: StoredConnection): Promise<StoredConnection> {
    this.rows.set(conn.provider, conn);
    return conn;
  }

  async remove(provider: ConnectionProvider): Promise<StoredConnection | null> {
    const existing = this.rows.get(provider) ?? null;
    this.rows.delete(provider);
    return existing;
  }
}

/** In-memory ingested-document registry. Lost on restart — fine for the preview. */
export class MemoryDocumentStore implements DocumentStore {
  private rows = new Map<string, IngestedDocument>();

  async list(): Promise<IngestedDocument[]> {
    return [...this.rows.values()].sort((a, b) => b.ingested_at.localeCompare(a.ingested_at));
  }
  async get(id: string): Promise<IngestedDocument | null> {
    return this.rows.get(id) ?? null;
  }
  async upsert(doc: IngestedDocument): Promise<IngestedDocument> {
    this.rows.set(doc.id, doc);
    return doc;
  }
  async remove(id: string): Promise<IngestedDocument | null> {
    const existing = this.rows.get(id) ?? null;
    this.rows.delete(id);
    return existing;
  }
}

/** In-memory folder-source registry. Lost on restart — fine for the preview. */
export class MemoryFolderSourceStore implements FolderSourceStore {
  private rows = new Map<string, DriveFolderSource>();

  async list(): Promise<DriveFolderSource[]> {
    return [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async get(id: string): Promise<DriveFolderSource | null> {
    return this.rows.get(id) ?? null;
  }
  async upsert(folder: DriveFolderSource): Promise<DriveFolderSource> {
    this.rows.set(folder.id, folder);
    return folder;
  }
  async remove(id: string): Promise<DriveFolderSource | null> {
    const existing = this.rows.get(id) ?? null;
    this.rows.delete(id);
    return existing;
  }
}

/** In-memory user store. Seeded with the env admin on startup. */
export class MemoryUserStore implements UserStore {
  private rows = new Map<string, StoredUser>();

  async list(): Promise<StoredUser[]> {
    return [...this.rows.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async count(): Promise<number> {
    return this.rows.size;
  }
  async getById(id: string): Promise<StoredUser | null> {
    return this.rows.get(id) ?? null;
  }
  async getByEmail(email: string): Promise<StoredUser | null> {
    const lower = email.toLowerCase();
    return [...this.rows.values()].find((u) => u.email.toLowerCase() === lower) ?? null;
  }
  async create(user: NewUser): Promise<StoredUser> {
    const now = new Date().toISOString();
    const row: StoredUser = {
      id: randomUUID(),
      email: user.email,
      name: user.name,
      role: user.role,
      password_hash: user.password_hash,
      disabled: false,
      created_at: now,
      last_login_at: null,
    };
    this.rows.set(row.id, row);
    return row;
  }
  async update(id: string, patch: UserUpdate): Promise<StoredUser | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.role !== undefined) row.role = patch.role;
    if (patch.disabled !== undefined) row.disabled = patch.disabled;
    if (patch.password_hash !== undefined) row.password_hash = patch.password_hash;
    if (patch.last_login_at !== undefined) row.last_login_at = patch.last_login_at;
    return row;
  }
  async remove(id: string): Promise<StoredUser | null> {
    const existing = this.rows.get(id) ?? null;
    this.rows.delete(id);
    return existing;
  }
}

export async function createMemoryStorage(): Promise<Storage> {
  const knowledge = new MemoryKnowledgeStore();
  await knowledge.init();
  return {
    knowledge,
    drafts: new MemoryDraftStore(),
    connections: new MemoryConnectionStore(),
    documents: new MemoryDocumentStore(),
    folders: new MemoryFolderSourceStore(),
    users: new MemoryUserStore(),
    usesPostgres: false,
  };
}
