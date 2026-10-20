import { env } from './env.js';
import type { Storage } from './stores/types.js';

// Selects the storage backend from STORAGE (default 'memory' → no database).
let cached: Storage | null = null;

export async function getStorage(): Promise<Storage> {
  if (cached) return cached;
  if (env.storage === 'postgres') {
    const { PgKnowledgeStore, PgDraftStore } = await import('./stores/postgres.js');
    cached = { knowledge: new PgKnowledgeStore(), drafts: new PgDraftStore(), usesPostgres: true };
  } else {
    const { createMemoryStorage } = await import('./stores/memory.js');
    cached = await createMemoryStorage();
  }
  return cached;
}
