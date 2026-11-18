// Outbound/inbound SMS for the sales follow-up agent.
//
// Which number sends the texts is still an open question for the client, so
// the transport is pluggable:
//   - "twilio": real two-way SMS when TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are
//     set. The sender is the rep's own number (kw_profiles.sms_from) or the
//     shared TWILIO_FROM. Replies arrive at POST /api/kw/sms/inbound.
//   - "outbox" (default): nothing leaves the building. Texts are recorded as
//     sent so the whole flow can be piloted on test data, and a client reply
//     can be simulated from the client's page.
import { createHmac, timingSafeEqual } from 'node:crypto';
import '../env.js'; // loads .env before we read process.env below

const SID = process.env.TWILIO_ACCOUNT_SID ?? '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN ?? '';
const DEFAULT_FROM = process.env.TWILIO_FROM ?? '';

export type SmsMode = 'twilio' | 'outbox';

export function smsMode(): SmsMode {
  return SID && TOKEN && (DEFAULT_FROM || process.env.KW_PER_REP_NUMBERS === '1') ? 'twilio' : 'outbox';
}

export function defaultFrom(): string | null {
  return smsMode() === 'twilio' ? DEFAULT_FROM || null : null;
}

export interface SendOutcome {
  ok: boolean;
  providerId?: string;
  error?: string;
}

export async function sendSms(to: string, body: string, from?: string): Promise<SendOutcome> {
  if (smsMode() === 'outbox') {
    // Never log the customer's number or the message text.
    console.log(`[keepwarm:outbox] SMS held (dry-run) → …${to.replace(/\D/g, '').slice(-3)}, ${body.length} chars`);
    return { ok: true, providerId: `outbox-${Date.now()}` };
  }
  const sender = from || DEFAULT_FROM;
  if (!sender) return { ok: false, error: 'No sending number configured for this rep' };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: sender, Body: body }).toString(),
      // Bounded: a hung request must not stall the send loop. A timeout is
      // recorded as 'failed' (never auto-retried), so it can't double-send.
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) return { ok: false, error: json.message || `Twilio HTTP ${res.status}` };
    return { ok: true, providerId: json.sid };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Validate Twilio's X-Twilio-Signature for an inbound webhook. */
export function validTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!TOKEN || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = createHmac('sha1', TOKEN).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Opt-out keywords (carrier-standard plus plain-English). */
export function isStopMessage(body: string): boolean {
  const t = body.trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out|opt-out)$/.test(t)) return true;
  return /\b(stop (texting|messaging|contacting) me|don'?t (text|message|contact) me|remove me|unsubscribe)\b/.test(t);
}
