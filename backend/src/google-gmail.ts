import type { GmailLabel } from '@tsba/shared';
import { getAccessToken } from './connections.js';

// ─── Gmail API v1 client ─────────────────────────────────────────────────────
// Uses the stored `gmail` OAuth token. Reads labels + messages, and (only via
// the explicit reply action) sends a reply back to a message's thread.

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

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  threadId: string;
  subject: string;
  from: string;
  date: string;
  text: string;
  /** The RFC822 Message-ID header, used to thread a reply (In-Reply-To). */
  messageId: string;
  webUrl: string;
}

/** A lightweight inbox item for the query list (no full body fetch). */
export interface GmailSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  webUrl: string;
}

function headerOf(headers: { name: string; value: string }[], name: string): string {
  return headers.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/** List recent messages under a label (default INBOX) as lightweight summaries. */
export async function listInbox(labelId: string, max: number): Promise<GmailSummary[]> {
  const ids = await listMessageIds(labelId, max);
  const items = await Promise.all(
    ids.map(async (id) => {
      try {
        const data = await api<{
          threadId?: string;
          snippet?: string;
          payload?: { headers?: { name: string; value: string }[] };
        }>(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
        const headers = data.payload?.headers ?? [];
        return {
          id,
          threadId: data.threadId ?? id,
          subject: headerOf(headers, 'Subject') || '(no subject)',
          from: headerOf(headers, 'From'),
          date: headerOf(headers, 'Date'),
          snippet: (data.snippet ?? '').replace(/\s+/g, ' ').trim(),
          webUrl: `https://mail.google.com/mail/u/0/#all/${id}`,
        } as GmailSummary;
      } catch {
        return null;
      }
    }),
  );
  return items.filter((x): x is GmailSummary => x !== null);
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
    threadId: (data as { threadId?: string }).threadId ?? id,
    subject: h('Subject') || '(no subject)',
    from: h('From'),
    date: h('Date'),
    text: extractBody(data.payload),
    messageId: h('Message-ID') || h('Message-Id'),
    webUrl: `https://mail.google.com/mail/u/0/#all/${id}`,
  };
}

/** Parse a bare email address out of a From/To header value. */
function emailAddress(value: string): string {
  const m = value.match(/<([^>]+)>/);
  return (m ? m[1] : value).trim();
}

function base64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Send a plain-text reply to a message's thread. `to` is the original sender,
 * `subject` is prefixed with "Re:" if needed, and the reply is threaded via the
 * original Message-ID. Requires the gmail.send scope.
 */
export async function sendReply(args: {
  to: string;
  subject: string;
  body: string;
  threadId: string;
  inReplyTo?: string;
}): Promise<{ id: string; threadId: string }> {
  const to = emailAddress(args.to);
  const subject = /^re:/i.test(args.subject) ? args.subject : `Re: ${args.subject}`;
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
  ];
  if (args.inReplyTo) {
    lines.push(`In-Reply-To: ${args.inReplyTo}`, `References: ${args.inReplyTo}`);
  }
  const raw = base64Url(`${lines.join('\r\n')}\r\n\r\n${args.body}`);
  return apiPost<{ id: string; threadId: string }>('/messages/send', { raw, threadId: args.threadId });
}
