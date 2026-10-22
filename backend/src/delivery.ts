import type { Draft, DraftDelivery } from '@tsba/shared';
import { env } from './env.js';

// Outbound delivery of approved replies — the "Send approved reply" node in the
// flow. Pluggable by provider so new channels (SMTP email, Twilio SMS, WhatsApp)
// can be added without touching the approval path. Providers never throw: they
// return a DraftDelivery describing what happened, so a delivery failure never
// blocks the human approval it follows.

export interface OutboundMessage {
  draftId: number;
  channel: Draft['channel']; // the medium the customer used: chat / text / email
  recipient: string | null;
  subject: string;
  body: string;
  sources: { title: string; source: string }[];
}

function now(): string {
  return new Date().toISOString();
}

/** Default, safe provider: logs the reply, sends nothing off the box. */
async function viaConsole(msg: OutboundMessage): Promise<DraftDelivery> {
  console.info(
    `[delivery] DRY-RUN draft #${msg.draftId} → ${msg.recipient ?? '(no recipient)'} via ${msg.channel}\n${msg.body}`,
  );
  return {
    status: 'delivered',
    channel: 'console',
    detail:
      'Dry-run: logged to the server console, not sent externally. Set DELIVERY_PROVIDER=webhook (and DELIVERY_WEBHOOK_URL) to send for real.',
    at: now(),
  };
}

/** Real provider: POST the approved reply to a configured outbound webhook. */
async function viaWebhook(msg: OutboundMessage): Promise<DraftDelivery> {
  if (!env.deliveryWebhookUrl) {
    return {
      status: 'failed',
      channel: 'webhook',
      detail: 'DELIVERY_PROVIDER=webhook but DELIVERY_WEBHOOK_URL is not set.',
      at: now(),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.deliveryTimeoutMs);
  try {
    const res = await fetch(env.deliveryWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.deliveryWebhookToken ? { Authorization: `Bearer ${env.deliveryWebhookToken}` } : {}),
      },
      body: JSON.stringify({
        draftId: msg.draftId,
        channel: msg.channel,
        recipient: msg.recipient,
        subject: msg.subject,
        body: msg.body,
        sources: msg.sources,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        status: 'failed',
        channel: 'webhook',
        detail: `Delivery webhook responded HTTP ${res.status}.`,
        at: now(),
      };
    }
    return {
      status: 'delivered',
      channel: 'webhook',
      detail: `Posted to delivery webhook (HTTP ${res.status}).`,
      at: now(),
    };
  } catch (err) {
    const e = err as Error;
    const reason = e.name === 'AbortError' ? `timed out after ${env.deliveryTimeoutMs}ms` : e.message;
    return { status: 'failed', channel: 'webhook', detail: `Delivery webhook request failed: ${reason}.`, at: now() };
  } finally {
    clearTimeout(timer);
  }
}

export function buildOutboundMessage(draft: Draft): OutboundMessage {
  return {
    draftId: draft.id,
    channel: draft.channel,
    recipient: draft.recipient,
    subject: 'TSBA Technical Support',
    body: draft.reply,
    sources: draft.sources.map((s) => ({ title: s.title, source: s.source })),
  };
}

/**
 * Dispatch an approved reply on the configured outbound channel. Only call this
 * for drafts that were approved for sending (status 'sent'); handovers go to the
 * internal team, not the customer.
 */
export async function deliverApprovedReply(draft: Draft): Promise<DraftDelivery> {
  const msg = buildOutboundMessage(draft);
  switch (env.deliveryProvider) {
    case 'webhook':
      return viaWebhook(msg);
    case 'console':
    default:
      return viaConsole(msg);
  }
}
