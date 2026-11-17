/**
 * Errors whose message is written for the person using the app (validation:
 * "…is not a valid email address"). Anything else — database, Google, SMTP,
 * provider, Anthropic errors — can carry hostnames, SQL or internal details, so
 * it is logged server-side and the client gets a plain, actionable message.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** The message safe to show the client: a UserError's own text, otherwise `fallback` (and the real error is logged). */
export function publicMessage(err: unknown, fallback: string): string {
  if (err instanceof UserError) return err.message;
  console.error(`[api] ${fallback} —`, err instanceof Error ? err.stack || err.message : err);
  return fallback;
}
