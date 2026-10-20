import type { Draft, KnowledgeEntry } from '@tsba/shared';
import { retrieve } from '../retrieval.js';
import { insertDraft, listDrafts, getDraft, updateDraft } from '../drafts-repo.js';
import type { DraftStore, InsertDraftArgs, KnowledgeStore } from './types.js';

// Postgres-backed stores: thin adapters over the existing SQL modules.

export class PgKnowledgeStore implements KnowledgeStore {
  retrieve(question: string, topK: number): Promise<KnowledgeEntry[]> {
    return retrieve(question, topK);
  }
}

export class PgDraftStore implements DraftStore {
  insert(args: InsertDraftArgs): Promise<Draft> {
    return insertDraft(args);
  }
  list(): Promise<Draft[]> {
    return listDrafts();
  }
  get(id: number): Promise<Draft | null> {
    return getDraft(id);
  }
  update(id: number, action: 'approve' | 'reject' | 'edit', text?: string): Promise<Draft | null> {
    return updateDraft(id, action, text);
  }
}
