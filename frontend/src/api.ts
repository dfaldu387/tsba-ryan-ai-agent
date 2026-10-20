import type { Audience, Channel, Draft, DraftAction } from '@tsba/shared';
import type { ProgressBoard } from './types';

const TOKEN_KEY = 'tsba-preview-token';

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
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) };
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

export async function login(password: string): Promise<void> {
  const { token } = await request<{ token: string }>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  setToken(token);
}

export function createDraft(body: { question: string; audience: Audience; channel: Channel }): Promise<Draft> {
  return request<Draft>('/api/draft', { method: 'POST', body: JSON.stringify(body) });
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
