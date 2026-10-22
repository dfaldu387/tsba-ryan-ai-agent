import type {
  AdminOverview,
  AuthenticatedUser,
  Audience,
  Channel,
  ConnectionProvider,
  ConnectionStatus,
  Draft,
  DraftAction,
  DriveFile,
  DriveFolderSource,
  DriveListing,
  FolderSyncResult,
  GmailLabel,
  GmailScanResult,
  IngestResult,
  IngestedDocument,
  Role,
  User,
} from '@tsba/shared';
import type { ProgressBoard } from './types';

const TOKEN_KEY = 'tsba-preview-token';
const USER_KEY = 'tsba-preview-user';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function setToken(t: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* ignore */
  }
}
export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

export function getStoredUser(): AuthenticatedUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthenticatedUser>;
    // Reject a stale/malformed cached user (e.g. from an older schema) so the app
    // falls back to a fresh /api/me (or login) instead of crashing on render.
    if (!parsed || typeof parsed.email !== 'string' || typeof parsed.id !== 'string') {
      localStorage.removeItem(USER_KEY);
      return null;
    }
    return parsed as AuthenticatedUser;
  } catch {
    return null;
  }
}
function setStoredUser(u: AuthenticatedUser): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(u));
  } catch {
    /* ignore */
  }
}

export class AuthError extends Error {}
export class ApiError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  // Only declare a JSON body when we actually send one — a POST/PATCH with no
  // body + Content-Type: application/json makes Fastify reject it as empty JSON.
  if (init.body != null) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    throw new AuthError('unauthorized');
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError((body.message as string) || (body.error as string) || `HTTP ${res.status}`, body.error as string);
  }
  return body as T;
}

export async function login(email: string, password: string): Promise<AuthenticatedUser> {
  const { token, user } = await request<{ token: string; user: AuthenticatedUser }>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setToken(token);
  setStoredUser(user);
  return user;
}

/** Restore the session from the stored token; returns the live user or null. */
export async function getMe(): Promise<AuthenticatedUser> {
  const user = await request<AuthenticatedUser>('/api/me');
  setStoredUser(user);
  return user;
}

// ─── User management (admin only) ───────────────────────────────────────────
export function listUsers(): Promise<{ users: User[] }> {
  return request<{ users: User[] }>('/api/users');
}

export function createUser(body: { email: string; name: string; role: Role; password: string }): Promise<User> {
  return request<User>('/api/users', { method: 'POST', body: JSON.stringify(body) });
}

export function updateUser(
  id: string,
  patch: { role?: Role; disabled?: boolean; name?: string; password?: string },
): Promise<User> {
  return request<User>(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function deleteUser(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/users/${id}`, { method: 'DELETE' });
}

// ─── Gmail scan ─────────────────────────────────────────────────────────────
export function listGmailLabels(): Promise<{ labels: GmailLabel[] }> {
  return request<{ labels: GmailLabel[] }>('/api/gmail/labels');
}

export function scanGmailLabel(labelId: string, max?: number): Promise<GmailScanResult> {
  return request<GmailScanResult>('/api/gmail/scan', {
    method: 'POST',
    body: JSON.stringify({ labelId, ...(max ? { max } : {}) }),
  });
}

export function createDraft(body: {
  question: string;
  audience: Audience;
  channel: Channel;
  recipient?: string | null;
}): Promise<Draft> {
  return request<Draft>('/api/draft', { method: 'POST', body: JSON.stringify(body) });
}

export interface VoiceChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function voiceChat(
  messages: VoiceChatMessage[],
  audience: Audience,
): Promise<{ reply: string }> {
  return request<{ reply: string }>('/api/voice/chat', {
    method: 'POST',
    body: JSON.stringify({ messages, audience }),
  });
}

export function listDrafts(): Promise<Draft[]> {
  return request<Draft[]>('/api/drafts');
}

export function patchDraft(id: number, action: DraftAction): Promise<Draft> {
  return request<Draft>(`/api/drafts/${id}`, { method: 'PATCH', body: JSON.stringify(action) });
}

export function getProgress(): Promise<ProgressBoard> {
  return request<ProgressBoard>('/api/progress');
}

export function getOverview(): Promise<AdminOverview> {
  return request<AdminOverview>('/api/overview');
}

export function listConnections(): Promise<{ connections: ConnectionStatus[] }> {
  return request<{ connections: ConnectionStatus[] }>('/api/connections');
}

/** Start an OAuth flow; returns the Google consent URL to redirect the browser to. */
export function startConnect(provider: ConnectionProvider): Promise<{ url: string }> {
  return request<{ url: string }>(`/api/connections/${provider}/connect`, { method: 'POST' });
}

export function disconnect(provider: ConnectionProvider): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/connections/${provider}`, { method: 'DELETE' });
}

export function listDriveFiles(folderId?: string, pageToken?: string): Promise<DriveListing> {
  const qs = new URLSearchParams();
  if (folderId) qs.set('folderId', folderId);
  if (pageToken) qs.set('pageToken', pageToken);
  const q = qs.toString();
  return request<DriveListing>(`/api/drive/files${q ? `?${q}` : ''}`);
}

export function searchDriveFiles(q: string): Promise<{ files: DriveFile[] }> {
  return request<{ files: DriveFile[] }>(`/api/drive/search?q=${encodeURIComponent(q)}`);
}

export function ingestDriveFiles(fileIds: string[]): Promise<{ results: IngestResult[] }> {
  return request<{ results: IngestResult[] }>('/api/drive/ingest', {
    method: 'POST',
    body: JSON.stringify({ fileIds }),
  });
}

export function listDocuments(): Promise<{ documents: IngestedDocument[] }> {
  return request<{ documents: IngestedDocument[] }>('/api/drive/documents');
}

export function removeDocument(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/drive/documents/${id}`, { method: 'DELETE' });
}

/** Assess stored text quality for all Drive docs (no OCR) and record the flags. */
export function assessDocuments(): Promise<{ assessed: number; ok: number; low: number; corrupted: number }> {
  return request<{ assessed: number; ok: number; low: number; corrupted: number }>(
    '/api/drive/documents/assess',
    { method: 'POST' },
  );
}

/** Re-ingest (with OCR) every Drive document whose text is flagged low/corrupted. */
export function reingestFlaggedDocuments(): Promise<{ reingested: number; results: IngestResult[] }> {
  return request<{ reingested: number; results: IngestResult[] }>('/api/drive/documents/reingest-flagged', {
    method: 'POST',
  });
}

export function listFolderSources(): Promise<{ folders: DriveFolderSource[] }> {
  return request<{ folders: DriveFolderSource[] }>('/api/drive/folders');
}

export function addFolderSource(folderId: string, recursive: boolean): Promise<FolderSyncResult> {
  return request<FolderSyncResult>('/api/drive/folders', {
    method: 'POST',
    body: JSON.stringify({ folderId, recursive }),
  });
}

export function addFolderSourcesBulk(
  folderIds: string[],
  recursive: boolean,
): Promise<{ folders: FolderSyncResult[] }> {
  return request<{ folders: FolderSyncResult[] }>('/api/drive/folders/bulk', {
    method: 'POST',
    body: JSON.stringify({ folderIds, recursive }),
  });
}

export function syncFolderSource(id: string): Promise<FolderSyncResult> {
  return request<FolderSyncResult>(`/api/drive/folders/${id}/sync`, { method: 'POST' });
}

export function syncAllFolderSources(): Promise<{ folders: FolderSyncResult[] }> {
  return request<{ folders: FolderSyncResult[] }>('/api/drive/folders/sync-all', { method: 'POST' });
}

/** Delete all Drive documents + chunks, then re-sync every folder from scratch. */
export function resyncAll(): Promise<{ folders: FolderSyncResult[] }> {
  return request<{ folders: FolderSyncResult[] }>('/api/drive/resync-all', { method: 'POST' });
}

export function removeFolderSource(id: string, purge: boolean): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/drive/folders/${id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' });
}
