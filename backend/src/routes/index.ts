import type { FastifyInstance } from 'fastify';
import {
  isAudience,
  isChannel,
  type SourceCard,
} from '@tsba/shared';
import { issueToken, passwordMatches, requireAuth } from '../auth.js';
import { env } from '../env.js';
import { anthropicConfigured, draftReply } from '../anthropic.js';
import { buildPrompt } from '../prompt.js';
import { offlineDraft } from '../offline-draft.js';
import { getStorage } from '../storage.js';
import { progressBoard } from '../progress.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ── Public ────────────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({
    ok: true,
    anthropic: anthropicConfigured(),
    embeddingProvider: env.embeddingProvider,
    storage: env.storage,
  }));

  app.post<{ Body: { password?: string } }>('/api/login', async (req, reply) => {
    const password = req.body?.password ?? '';
    if (!passwordMatches(password)) {
      return reply.code(401).send({ error: 'wrong_password' });
    }
    return { token: issueToken() };
  });

  // ── Protected ───────────────────────────────────────────────────────────────
  app.post<{ Body: { question?: string; audience?: string; channel?: string } }>(
    '/api/draft',
    { preHandler: requireAuth },
    async (req, reply) => {
      const question = (req.body?.question ?? '').trim();
      const audience = req.body?.audience;
      const channel = req.body?.channel;

      if (!question) return reply.code(400).send({ error: 'question_required' });
      if (!isAudience(audience)) return reply.code(400).send({ error: 'invalid_audience' });
      if (!isChannel(channel)) return reply.code(400).send({ error: 'invalid_channel' });

      try {
        const storage = await getStorage();
        const entries = await storage.knowledge.retrieve(question, env.retrievalTopK);

        // Use Claude when a key is set; otherwise fall back to an offline draft
        // composed from the retrieved knowledge so the preview still works.
        const result = anthropicConfigured()
          ? await draftReply(buildPrompt({ question, audience, channel, entries }))
          : offlineDraft({ question, audience, channel, entries });

        // Resolve the cited ids into source cards (only ids we actually retrieved).
        const byId = new Map(entries.map((e) => [e.id, e]));
        const sources: SourceCard[] = result.sources
          .map((id) => byId.get(id))
          .filter((e): e is NonNullable<typeof e> => Boolean(e))
          .map((e) => ({ id: e.id, kind: e.kind, title: e.title, source: e.source }));

        const draft = await storage.drafts.insert({ question, audience, channel, result, sources });
        return draft;
      } catch (err) {
        req.log.error({ err }, 'draft failed');
        return reply.code(502).send({ error: 'draft_failed', message: (err as Error).message });
      }
    },
  );

  app.get('/api/drafts', { preHandler: requireAuth }, async () => {
    const storage = await getStorage();
    return storage.drafts.list();
  });

  app.patch<{ Params: { id: string }; Body: { action?: string; text?: string } }>(
    '/api/drafts/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = Number(req.params.id);
      const action = req.body?.action;
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });
      if (action !== 'approve' && action !== 'reject' && action !== 'edit') {
        return reply.code(400).send({ error: 'invalid_action' });
      }
      if (action === 'edit' && typeof req.body?.text !== 'string') {
        return reply.code(400).send({ error: 'text_required' });
      }
      const storage = await getStorage();
      const updated = await storage.drafts.update(id, action, req.body?.text);
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return updated;
    },
  );

  app.get('/api/progress', { preHandler: requireAuth }, async () => progressBoard());
}
