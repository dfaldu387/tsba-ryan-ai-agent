import type { Audience, Channel, Draft, DraftResult, KnowledgeEntry, SourceCard } from '@tsba/shared';

export interface KnowledgeStore {
  retrieve(question: string, topK: number): Promise<KnowledgeEntry[]>;
}

export interface InsertDraftArgs {
  question: string;
  audience: Audience;
  channel: Channel;
  result: DraftResult;
  sources: SourceCard[];
}

export interface DraftStore {
  insert(args: InsertDraftArgs): Promise<Draft>;
  list(): Promise<Draft[]>;
  get(id: number): Promise<Draft | null>;
  update(id: number, action: 'approve' | 'reject' | 'edit', text?: string): Promise<Draft | null>;
}

export interface Storage {
  knowledge: KnowledgeStore;
  drafts: DraftStore;
  usesPostgres: boolean;
}
