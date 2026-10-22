import type {
  Audience,
  Channel,
  ConnectionProvider,
  Draft,
  DraftDelivery,
  DraftResult,
  DriveFolderSource,
  IngestedDocument,
  KnowledgeEntry,
  Role,
  SourceCard,
  User,
} from '@tsba/shared';

export interface KnowledgeStore {
  /**
   * Retrieve the knowledge for a question. When `brand` is given (detected from
   * the conversation), entries for that brand — plus brand-agnostic ones — are
   * boosted so the matching manufacturer's source ranks first.
   */
  retrieve(question: string, topK: number, brand?: string | null): Promise<KnowledgeEntry[]>;
  /** Add (or replace) knowledge entries and embed them so they're retrievable. */
  add(entries: KnowledgeEntry[]): Promise<void>;
  /** Remove entries whose id starts with the given prefix (e.g. a document's chunks). */
  removeByPrefix(idPrefix: string): Promise<void>;
  /** All chunk text for entries whose id starts with the prefix, joined — for quality assessment. */
  getTextByPrefix(idPrefix: string): Promise<string>;
}

export interface InsertDraftArgs {
  question: string;
  audience: Audience;
  channel: Channel;
  result: DraftResult;
  sources: SourceCard[];
  recipient?: string | null;
}

export interface DraftStore {
  insert(args: InsertDraftArgs): Promise<Draft>;
  list(): Promise<Draft[]>;
  get(id: number): Promise<Draft | null>;
  update(id: number, action: 'approve' | 'reject' | 'edit', text?: string): Promise<Draft | null>;
  /** Record the outcome of dispatching an approved reply. */
  recordDelivery(id: number, delivery: DraftDelivery): Promise<Draft | null>;
}

/** A stored connector record, including encrypted OAuth tokens. */
export interface StoredConnection {
  provider: ConnectionProvider;
  account_email: string | null;
  scopes: string[];
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: string; // ISO
  connected_at: string;
  updated_at: string;
}

export interface ConnectionStore {
  get(provider: ConnectionProvider): Promise<StoredConnection | null>;
  list(): Promise<StoredConnection[]>;
  upsert(conn: StoredConnection): Promise<StoredConnection>;
  remove(provider: ConnectionProvider): Promise<StoredConnection | null>;
}

export interface DocumentStore {
  list(): Promise<IngestedDocument[]>;
  get(id: string): Promise<IngestedDocument | null>;
  upsert(doc: IngestedDocument): Promise<IngestedDocument>;
  remove(id: string): Promise<IngestedDocument | null>;
}

export interface FolderSourceStore {
  list(): Promise<DriveFolderSource[]>;
  get(id: string): Promise<DriveFolderSource | null>;
  upsert(folder: DriveFolderSource): Promise<DriveFolderSource>;
  remove(id: string): Promise<DriveFolderSource | null>;
}

/** A user row including the password hash (never leaves the server as-is). */
export interface StoredUser extends User {
  password_hash: string;
}

export interface NewUser {
  email: string;
  name: string;
  role: Role;
  password_hash: string;
}

export interface UserUpdate {
  name?: string;
  role?: Role;
  disabled?: boolean;
  password_hash?: string;
  last_login_at?: string;
}

export interface UserStore {
  list(): Promise<StoredUser[]>;
  count(): Promise<number>;
  getById(id: string): Promise<StoredUser | null>;
  getByEmail(email: string): Promise<StoredUser | null>;
  create(user: NewUser): Promise<StoredUser>;
  update(id: string, patch: UserUpdate): Promise<StoredUser | null>;
  remove(id: string): Promise<StoredUser | null>;
}

export interface Storage {
  knowledge: KnowledgeStore;
  drafts: DraftStore;
  connections: ConnectionStore;
  documents: DocumentStore;
  folders: FolderSourceStore;
  users: UserStore;
  usesPostgres: boolean;
}
