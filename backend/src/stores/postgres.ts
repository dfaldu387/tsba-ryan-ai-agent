import type {
  ConnectionProvider,
  Draft,
  DraftDelivery,
  DriveFolderSource,
  IngestedDocument,
  KnowledgeEntry,
} from '@tsba/shared';
import { retrieve } from '../retrieval.js';
import { insertDraft, listDrafts, getDraft, updateDraft, recordDraftDelivery } from '../drafts-repo.js';
import {
  getConnection,
  listConnections,
  removeConnection,
  upsertConnection,
} from '../connections-repo.js';
import { addEntries, getEntryTextByPrefix, removeEntriesByPrefix } from '../knowledge-repo.js';
import {
  getDocument,
  listDocuments,
  removeDocument,
  upsertDocument,
} from '../documents-repo.js';
import {
  getFolder,
  listFolders,
  removeFolder,
  upsertFolder,
} from '../drive-folders-repo.js';
import {
  countUsers,
  createUser,
  getUserByEmail,
  getUserById,
  listUsers,
  removeUser,
  updateUser,
} from '../users-repo.js';
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
  UserStore,
  UserUpdate,
} from './types.js';

// Postgres-backed stores: thin adapters over the existing SQL modules.

export class PgKnowledgeStore implements KnowledgeStore {
  retrieve(question: string, topK: number, brand?: string | null, model?: string | null): Promise<KnowledgeEntry[]> {
    return retrieve(question, topK, brand, model);
  }
  add(entries: KnowledgeEntry[]): Promise<void> {
    return addEntries(entries);
  }
  removeByPrefix(idPrefix: string): Promise<void> {
    return removeEntriesByPrefix(idPrefix);
  }
  getTextByPrefix(idPrefix: string): Promise<string> {
    return getEntryTextByPrefix(idPrefix);
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
  recordDelivery(id: number, delivery: DraftDelivery): Promise<Draft | null> {
    return recordDraftDelivery(id, delivery);
  }
}

export class PgConnectionStore implements ConnectionStore {
  get(provider: ConnectionProvider): Promise<StoredConnection | null> {
    return getConnection(provider);
  }
  list(): Promise<StoredConnection[]> {
    return listConnections();
  }
  upsert(conn: StoredConnection): Promise<StoredConnection> {
    return upsertConnection(conn);
  }
  remove(provider: ConnectionProvider): Promise<StoredConnection | null> {
    return removeConnection(provider);
  }
}

export class PgDocumentStore implements DocumentStore {
  list(): Promise<IngestedDocument[]> {
    return listDocuments();
  }
  get(id: string): Promise<IngestedDocument | null> {
    return getDocument(id);
  }
  upsert(doc: IngestedDocument): Promise<IngestedDocument> {
    return upsertDocument(doc);
  }
  remove(id: string): Promise<IngestedDocument | null> {
    return removeDocument(id);
  }
}

export class PgUserStore implements UserStore {
  list(): Promise<StoredUser[]> {
    return listUsers();
  }
  count(): Promise<number> {
    return countUsers();
  }
  getById(id: string): Promise<StoredUser | null> {
    return getUserById(id);
  }
  getByEmail(email: string): Promise<StoredUser | null> {
    return getUserByEmail(email);
  }
  create(user: NewUser): Promise<StoredUser> {
    return createUser(user);
  }
  update(id: string, patch: UserUpdate): Promise<StoredUser | null> {
    return updateUser(id, patch);
  }
  remove(id: string): Promise<StoredUser | null> {
    return removeUser(id);
  }
}

export class PgFolderSourceStore implements FolderSourceStore {
  list(): Promise<DriveFolderSource[]> {
    return listFolders();
  }
  get(id: string): Promise<DriveFolderSource | null> {
    return getFolder(id);
  }
  upsert(folder: DriveFolderSource): Promise<DriveFolderSource> {
    return upsertFolder(folder);
  }
  remove(id: string): Promise<DriveFolderSource | null> {
    return removeFolder(id);
  }
}
