import type { Audience, Channel } from '@tsba/shared';

// ─── Auto-detect the "source" of a support message ───────────────────────────
// For the live support chat the operator doesn't pick who's asking or on what
// channel — we infer it from the message itself. Deterministic and keyword-based
// (no model call, no tokens), and deliberately CONSERVATIVE on audience: the
// default is 'customer', which carries the strongest guardrails (no step-by-step
// electrical procedures). We only upgrade to 'installer' on clear trade signals,
// so a customer is never mistaken for an installer and handed electrical steps.

// High-precision installer/trade signals — jargon a customer almost never uses.
const INSTALLER_RE =
  /\b(i'?m an installer|as an installer|sparky|commission(?:ing|ed)?|as\/?nzs|mppt|dc isolator|export limit(?:ing|ation)?|anti-?islanding|ct clamp|neutral-?earth|busbar|torque|grid code|three[- ]?phase|3[- ]?phase|my client|the client'?s|cr\s?\d|clean energy council|cec)\b/i;

// Sales / commercial signals.
const SALES_RE =
  /\b(quote|quotation|pricing|price list|discount|wholesale|margin|lead time|availability|in stock|purchase order|\bpo\b|reseller|datasheet for (?:a|my|the) customer|proposal|sell|selling)\b/i;

/**
 * Infer who is asking from the message. Returns 'customer' unless there is a
 * clear installer or sales signal (installer wins ties — it's the more specific
 * vocabulary). Customer is the safe default.
 */
export function detectAudience(text: string): Audience {
  const t = text ?? '';
  if (INSTALLER_RE.test(t)) return 'installer';
  if (SALES_RE.test(t)) return 'sales';
  return 'customer';
}

// Formal email cues, or a long message, read as email; an explicit SMS cue as
// text; everything else is a live chat.
const EMAIL_RE = /\b(dear|hi team|regards|kind regards|best regards|sincerely|to whom it may concern|please find|follow(?:ing)? up on my email)\b/i;
const TEXT_RE = /\b(sms|txt|text me|via text|by text)\b/i;

/** Infer the channel a message reads like. Defaults to 'chat'. */
export function detectChannel(text: string): Channel {
  const t = (text ?? '').trim();
  if (EMAIL_RE.test(t) || t.length > 600) return 'email';
  if (TEXT_RE.test(t)) return 'text';
  return 'chat';
}
