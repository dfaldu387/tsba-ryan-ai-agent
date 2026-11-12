import nodemailer, { type Transporter } from 'nodemailer';
import { env, smtpConfigured } from './env.js';
import type { MailAttachment } from './google-gmail.js';

// ─── Outbound email via SMTP (Postmark) ──────────────────────────────────────
// Replaces the Gmail API for ALL outbound mail (solar alerts, test notifications
// and AI inbox replies). Inbox reading/labelling still uses the Gmail connector;
// only the *sending* side moved here. Postmark uses the same server token as the
// SMTP username and password; the From address must be a verified sender there.
//
// Note: replies sent over SMTP are standard RFC 2822 messages with In-Reply-To /
// References headers set, so compliant clients thread them — but they are NOT
// injected into the original Gmail thread the way the Gmail API did.

/** Thrown when SMTP isn't configured or the send fails, so callers can degrade. */
export class MailSendError extends Error {}

let transporter: Transporter | null = null;

/** Lazily build (and cache) the SMTP transport from env config. */
function getTransport(): Transporter {
  if (!smtpConfigured()) {
    throw new MailSendError(
      'SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM_EMAIL in .env.',
    );
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      // 465 = implicit TLS; 587/2525 = STARTTLS (secure:false, upgraded via requireTLS).
      secure: env.smtpPort === 465,
      requireTLS: env.smtpPort !== 465,
      auth: { user: env.smtpUser, pass: env.smtpPass },
    });
  }
  return transporter;
}

/** The RFC From header: `"TSBA Australia" <hello@dev-build.in>`. */
function fromHeader(): string {
  return env.smtpFromName ? `"${env.smtpFromName}" <${env.smtpFromEmail}>` : env.smtpFromEmail;
}

function toNodemailerAttachments(attachments?: MailAttachment[]) {
  return (attachments ?? []).map((a) => ({
    filename: a.filename,
    content: a.content,
    contentType: a.contentType,
  }));
}

/**
 * Send a fresh email (new thread). Mirrors the old Gmail `sendMail` signature so
 * it's a drop-in replacement. Returns an id/threadId pair for compatibility —
 * `id` is the SMTP Message-ID; `threadId` is empty (SMTP has no thread concept).
 */
export async function sendMail(args: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
}): Promise<{ id: string; threadId: string }> {
  try {
    const info = await getTransport().sendMail({
      from: fromHeader(),
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
      attachments: toNodemailerAttachments(args.attachments),
    });
    return { id: info.messageId ?? '', threadId: '' };
  } catch (err) {
    if (err instanceof MailSendError) throw err;
    throw new MailSendError(`SMTP send failed: ${(err as Error).message}`);
  }
}

/**
 * Send a reply. Mirrors the old Gmail `sendReply` signature. `threadId` is
 * accepted for call-site compatibility but unused (SMTP can't post into a Gmail
 * thread); threading is instead signalled via In-Reply-To / References headers.
 */
export async function sendReply(args: {
  to: string;
  subject: string;
  body: string;
  threadId: string;
  inReplyTo?: string;
}): Promise<{ id: string; threadId: string }> {
  const subject = /^re:/i.test(args.subject) ? args.subject : `Re: ${args.subject}`;
  const headers: Record<string, string> = {};
  if (args.inReplyTo) {
    headers['In-Reply-To'] = args.inReplyTo;
    headers['References'] = args.inReplyTo;
  }
  try {
    const info = await getTransport().sendMail({
      from: fromHeader(),
      to: args.to,
      subject,
      text: args.body,
      headers,
    });
    return { id: info.messageId ?? '', threadId: args.threadId };
  } catch (err) {
    if (err instanceof MailSendError) throw err;
    throw new MailSendError(`SMTP reply failed: ${(err as Error).message}`);
  }
}
