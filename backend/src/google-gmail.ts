import type { GmailLabel } from '@tsba/shared';
import { getAccessToken } from './connections.js';

// ─── Gmail API v1 client (read-only: labels + messages) ──────────────────────
// Uses the stored `gmail` OAuth token. Only labels.list, messages.list and
// messages.get are ever called — nothing is ever sent from the scan path.

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailAuthError extends Error {}

async function token(): Promise<string> {
  const t = await getAccessToken('gmail');
  if (!t) throw new GmailAuthError('gmail is not connected');
  return t;
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${await token()}` },
  });
  if (!res.ok) throw new Error(`Gmail ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** List labels the user can choose from (system + user labels). */
export async function listLabels(): Promise<GmailLabel[]> {
  const data = await api<{ labels?: { id: string; name: string; type?: string }[] }>('/labels');
  return (data.labels ?? [])
    .map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type === 'system' ? ('system' as const) : ('user' as const),
      messagesTotal: null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a label's display name (falls back to the id). */
export async function getLabelName(labelId: string): Promise<string> {
  try {
    const l = await api<{ name?: string }>(`/labels/${encodeURIComponent(labelId)}`);
    return l.name ?? labelId;
  } catch {
    return labelId;
  }
}

/** Collect up to `max` message ids under a label (paginates). */
export async function listMessageIds(labelId: string, max: number): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      labelIds: labelId,
      maxResults: String(Math.min(100, max - ids.length)),
      includeSpamTrash: 'false',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(
      `/messages?${params.toString()}`,
    );
    for (const m of data.messages ?? []) ids.push(m.id);
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

export interface GmailMessage {
  id: string;
  subject: string;
  from: string;
  date: string;
  text: string;
  webUrl: string;
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Walk MIME parts, preferring text/plain; fall back to stripped text/html. */
function extractBody(payload: Part | undefined): string {
  if (!payload) return '';
  let plain = '';
  let html = '';
  const walk = (p: Part) => {
    if (p.mimeType === 'text/plain' && p.body?.data) plain += decodeB64Url(p.body.data) + '\n';
    else if (p.mimeType === 'text/html' && p.body?.data) html += decodeB64Url(p.body.data) + '\n';
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);
  const text = plain.trim() || stripHtml(html);
  return text.trim();
}

/** Fetch one message's headers + body text. */
export async function getMessage(id: string): Promise<GmailMessage> {
  const data = await api<{
    payload?: Part & { headers?: { name: string; value: string }[] };
  }>(`/messages/${id}?format=full`);
  const headers = data.payload?.headers ?? [];
  const h = (name: string) =>
    headers.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  return {
    id,
    subject: h('Subject') || '(no subject)',
    from: h('From'),
    date: h('Date'),
    text: extractBody(data.payload),
    webUrl: `https://mail.google.com/mail/u/0/#all/${id}`,
  };
}
