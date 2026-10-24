import type { FastifyInstance } from 'fastify';
import {
  AGENT_PROFILE,
  isAudience,
  isChannel,
  isConnectionProvider,
  isRole,
  type AdminOverview,
  type DraftStatus,
  type SourceCard,
} from '@tsba/shared';
import { currentUser, issueToken, requireAuth, requirePermission } from '../auth.js';
import { appWebUrl, env, googleOAuthConfigured } from '../env.js';
import {
  anthropicConfigured,
  buildUserContent,
  chatReply,
  draftReply,
  suggestFollowups,
  suggestStarters,
  type ChatAttachment,
  type ChatTurn,
} from '../anthropic.js';
import { buildPrompt, buildVoiceSystem } from '../prompt.js';
import { offlineChat, offlineDraft } from '../offline-draft.js';
import { detectBrand, detectBrandFromTurns } from '../brand.js';
import { deliverApprovedReply } from '../delivery.js';
import { getStorage } from '../storage.js';
import { progressBoard } from '../progress.js';
import {
  authenticate,
  createUserAccount,
  toAuthenticatedUser,
  toPublicUser,
} from '../users.js';
import { hashPassword } from '../password.js';
import {
  buildAuthUrl,
  consumeState,
  createState,
  exchangeCode,
  fetchUserEmail,
} from '../google-oauth.js';
import { connectionStatuses, disconnect, saveConnection } from '../connections.js';
import { DriveAuthError, listFolder, searchFiles } from '../google-drive.js';
import {
  addFolderSource,
  addFolderSources,
  docChunkPrefix,
  ingestFiles,
  removeFolderSource,
  syncAllFolders,
  syncFolderById,
} from '../drive-ingest.js';
import { isLowQualityExtract, looksCorrupted } from '../text-quality.js';
import type { TextQuality } from '@tsba/shared';
import { removeIngestedDocument } from '../documents-service.js';
import { GmailAuthError, listLabels } from '../google-gmail.js';
import { scanLabel } from '../gmail-ingest.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ── Public ────────────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({
    ok: true,
    anthropic: anthropicConfigured(),
    embeddingProvider: env.embeddingProvider,
    storage: env.storage,
  }));

  // Email + password login. Returns a signed token and the authenticated user
  // (with the permissions their role grants).
  app.post<{ Body: { email?: string; password?: string } }>('/api/login', async (req, reply) => {
    const email = (req.body?.email ?? '').trim();
    const password = req.body?.password ?? '';
    if (!email || !password) return reply.code(400).send({ error: 'credentials_required' });

    const user = await authenticate(email, password);
    if (!user) return reply.code(401).send({ error: 'invalid_credentials' });

    return { token: issueToken(user.id), user: toAuthenticatedUser(user) };
  });

  // Who am I — used by the SPA to restore the session and gate the UI.
  app.get('/api/me', { preHandler: requireAuth }, async (req) => req.authUser);

  // ── Protected ───────────────────────────────────────────────────────────────
  app.post<{ Body: { question?: string; audience?: string; channel?: string; recipient?: string } }>(
    '/api/draft',
    { preHandler: requirePermission('ask') },
    async (req, reply) => {
      const question = (req.body?.question ?? '').trim();
      const audience = req.body?.audience;
      const channel = req.body?.channel;
      // Optional: where an approved reply should be sent. Bounded to a sane length.
      const recipient = (req.body?.recipient ?? '').trim().slice(0, 320) || null;

      if (!question) return reply.code(400).send({ error: 'question_required' });
      if (!isAudience(audience)) return reply.code(400).send({ error: 'invalid_audience' });
      if (!isChannel(channel)) return reply.code(400).send({ error: 'invalid_channel' });

      try {
        const storage = await getStorage();
        // Step 3 — identify the brand, then retrieve its matching source.
        const brand = detectBrand(question);
        const entries = await storage.knowledge.retrieve(question, env.retrievalTopK, brand);

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

        const draft = await storage.drafts.insert({ question, audience, channel, result, sources, recipient });
        return draft;
      } catch (err) {
        req.log.error({ err }, 'draft failed');
        return reply.code(502).send({ error: 'draft_failed', message: (err as Error).message });
      }
    },
  );

  // ── Voice agent: a natural multi-turn conversation (not a formal draft) ──────
  app.post<{ Body: { messages?: unknown; audience?: string; attachments?: unknown } }>(
    '/api/voice/chat',
    { preHandler: requirePermission('ask') },
    async (req, reply) => {
      const audience = req.body?.audience;
      if (!isAudience(audience)) return reply.code(400).send({ error: 'invalid_audience' });

      // Validate and bound the conversation history (text only — attachments ride
      // separately and are stitched onto the latest user turn below).
      const raw = Array.isArray(req.body?.messages) ? req.body!.messages : [];
      const texts: { role: 'user' | 'assistant'; content: string }[] = [];
      for (const m of raw) {
        if (!m || typeof m !== 'object') continue;
        const role = (m as { role?: unknown }).role;
        const content = (m as { content?: unknown }).content;
        if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
          texts.push({ role, content: content.trim().slice(0, 2000) });
        }
      }
      const recent = texts.slice(-12); // cap context sent to the model
      const lastUser = [...recent].reverse().find((t) => t.role === 'user');
      if (!lastUser) return reply.code(400).send({ error: 'no_user_message' });
      if (recent[recent.length - 1]?.role !== 'user') {
        return reply.code(400).send({ error: 'last_message_must_be_user' });
      }

      // Validate attachments (images / PDFs) for the latest user turn.
      const ALLOWED_MEDIA = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
      const MAX_ATTACHMENTS = 4;
      const MAX_ATTACHMENT_BYTES = 20_000_000; // ~20MB decoded per file
      const rawAtt = Array.isArray(req.body?.attachments) ? req.body!.attachments : [];
      const attachments: ChatAttachment[] = [];
      for (const a of rawAtt.slice(0, MAX_ATTACHMENTS)) {
        if (!a || typeof a !== 'object') continue;
        const mt = (a as { mediaType?: unknown }).mediaType;
        const data = (a as { data?: unknown }).data;
        if (typeof mt !== 'string' || !ALLOWED_MEDIA.has(mt)) continue;
        if (typeof data !== 'string' || !data) continue;
        if (data.length * 0.75 > MAX_ATTACHMENT_BYTES) return reply.code(413).send({ error: 'attachment_too_large' });
        attachments.push({ mediaType: mt as ChatAttachment['mediaType'], data });
      }

      try {
        const storage = await getStorage();
        // Step 3 — brand may have been named earlier in the call, so scan the
        // recent turns, not just the latest message.
        const brand = detectBrandFromTurns(recent.filter((t) => t.role === 'user').map((t) => t.content));
        const entries = await storage.knowledge.retrieve(lastUser.content, env.retrievalTopK, brand);

        // Attachments only help when a real model can read them; stitch them onto
        // the final user turn so Claude sees the file alongside the question.
        const modelTurns: ChatTurn[] =
          attachments.length > 0
            ? recent.map((t, i) =>
                i === recent.length - 1
                  ? { role: t.role, content: buildUserContent(t.content, attachments) }
                  : t,
              )
            : recent;

        const text = anthropicConfigured()
          ? await chatReply(buildVoiceSystem({ audience, entries }), modelTurns)
          : offlineChat({ question: lastUser.content, audience, entries });

        // Guarantee the client's mandated opening line, even if the model omits it.
        const OPENING = 'This is an automated response from TSBA Technical Support.';
        const reply = text.trimStart().startsWith(OPENING) ? text.trim() : `${OPENING} ${text.trim()}`;

        // Surface the documents this answer was grounded in, deduped by document
        // (chunk titles carry a "— part N/M" suffix) so the UI can cite them.
        const seen = new Set<string>();
        const sources: SourceCard[] = [];
        for (const e of entries) {
          if (e.kind !== 'maker') continue;
          const docTitle = e.title.replace(/\s*[—-]\s*part\s*\d+\s*\/\s*\d+\s*$/i, '').trim();
          if (seen.has(docTitle)) continue;
          seen.add(docTitle);
          sources.push({ id: e.id, kind: e.kind, title: docTitle, source: e.source });
        }

        // Contextual follow-up suggestions, generated from this answer (best-effort).
        const suggestions = anthropicConfigured()
          ? await suggestFollowups(lastUser.content, reply, sources.map((s) => s.title).join('\n'))
          : [];

        return { reply, sources, suggestions };
      } catch (err) {
        req.log.error({ err }, 'voice chat failed');
        return reply.code(502).send({ error: 'chat_failed', message: (err as Error).message });
      }
    },
  );

  // Opening suggestions for an empty voice chat, grounded in the KB. Cached briefly
  // so we don't call the model on every page load.
  let starterCache: { at: number; list: string[] } | null = null;
  const STARTER_TTL_MS = 10 * 60 * 1000;
  app.get('/api/voice/suggestions', { preHandler: requirePermission('ask') }, async () => {
    if (starterCache && Date.now() - starterCache.at < STARTER_TTL_MS) {
      return { suggestions: starterCache.list };
    }
    if (!anthropicConfigured()) return { suggestions: [] };
    const storage = await getStorage();
    // Sample some real products to ground the starter questions.
    const entries = await storage.knowledge.retrieve('inverter features efficiency backup warranty', 12, null);
    const context = [...new Set(entries.filter((e) => e.kind === 'maker').map((e) => `${e.brand} ${e.model}`.trim()))]
      .filter(Boolean)
      .slice(0, 10)
      .join('\n');
    const list = await suggestStarters(context);
    starterCache = { at: Date.now(), list };
    return { suggestions: list };
  });

  // Flag a voice answer for the team: records it as a handover draft so it shows
  // up in the approval queue and the header notification panel.
  app.post<{ Body: { question?: unknown; reply?: unknown; audience?: string; note?: unknown } }>(
    '/api/voice/flag',
    { preHandler: requirePermission('ask') },
    async (req, reply) => {
      const question = typeof req.body?.question === 'string' ? req.body.question.trim().slice(0, 2000) : '';
      const answer = typeof req.body?.reply === 'string' ? req.body.reply.trim().slice(0, 4000) : '';
      const audience = req.body?.audience;
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
      if (!question) return reply.code(400).send({ error: 'question_required' });
      if (!isAudience(audience)) return reply.code(400).send({ error: 'invalid_audience' });

      const storage = await getStorage();
      const draft = await storage.drafts.insert({
        question,
        audience,
        channel: 'chat',
        result: {
          outcome: 'handover',
          reply: answer || 'Flagged from the voice agent for team review.',
          sources: [],
          note_for_ryan: note,
          team_handover: {
            summary: note || 'An operator flagged this voice-agent answer for the team to confirm.',
            needed: [],
          },
        },
        sources: [],
      });
      return draft;
    },
  );

  app.get('/api/drafts', { preHandler: requirePermission('view') }, async () => {
    const storage = await getStorage();
    return storage.drafts.list();
  });

  app.patch<{ Params: { id: string }; Body: { action?: string; text?: string } }>(
    '/api/drafts/:id',
    { preHandler: requirePermission('approve_drafts') },
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
      let updated = await storage.drafts.update(id, action, req.body?.text);
      if (!updated) return reply.code(404).send({ error: 'not_found' });

      // When a reply is approved for sending (not a team handover), dispatch it on
      // the configured outbound channel and record the result. A delivery failure
      // must not fail the approval — the draft is already approved.
      if (action === 'approve' && updated.status === 'sent') {
        try {
          const delivery = await deliverApprovedReply(updated);
          updated = (await storage.drafts.recordDelivery(updated.id, delivery)) ?? updated;
        } catch (err) {
          req.log.error({ err }, 'delivery failed');
        }
      }
      return updated;
    },
  );

  app.get('/api/progress', { preHandler: requirePermission('view') }, async () => progressBoard());

  // ── Admin overview ──────────────────────────────────────────────────────────
  // One read-only snapshot for the Admin panel: the agent's identity plus live
  // system, knowledge-base, connection and draft-activity numbers. No secrets.
  app.get('/api/overview', { preHandler: requirePermission('view') }, async (): Promise<AdminOverview> => {
    const storage = await getStorage();
    const [documents, folders, drafts, connections, users] = await Promise.all([
      storage.documents.list(),
      storage.folders.list(),
      storage.drafts.list(),
      connectionStatuses(),
      storage.users.list(),
    ]);

    const countBy = (status: DraftStatus) => drafts.filter((d) => d.status === status).length;
    const chunks = documents.reduce((sum, d) => sum + (d.chunk_count || 0), 0);

    return {
      agent: AGENT_PROFILE,
      system: {
        anthropic: anthropicConfigured(),
        model: env.anthropicModel,
        embeddingProvider: env.embeddingProvider,
        storage: env.storage,
        usesPostgres: storage.usesPostgres,
      },
      knowledge: {
        documents: documents.length,
        chunks,
        folderSources: folders.length,
        driveDocuments: documents.filter((d) => d.source === 'google-drive').length,
        emailDocuments: documents.filter((d) => d.source === 'gmail').length,
      },
      users: {
        total: users.length,
        admins: users.filter((u) => u.role === 'admin').length,
      },
      connections,
      drafts: {
        total: drafts.length,
        pending: countBy('pending'),
        sent: countBy('sent'),
        team: countBy('team'),
        rejected: countBy('rejected'),
      },
    };
  });

  // ── User management (admin only) ────────────────────────────────────────────
  app.get('/api/users', { preHandler: requirePermission('manage_users') }, async () => {
    const storage = await getStorage();
    const users = await storage.users.list();
    return { users: users.map(toPublicUser) };
  });

  app.post<{ Body: { email?: string; name?: string; role?: string; password?: string } }>(
    '/api/users',
    { preHandler: requirePermission('manage_users') },
    async (req, reply) => {
      const email = (req.body?.email ?? '').trim();
      const name = (req.body?.name ?? '').trim();
      const role = req.body?.role;
      const password = req.body?.password ?? '';
      if (!email || !/.+@.+\..+/.test(email)) return reply.code(400).send({ error: 'invalid_email' });
      if (!isRole(role)) return reply.code(400).send({ error: 'invalid_role' });
      if (password.length < 8) return reply.code(400).send({ error: 'weak_password', message: 'Password must be at least 8 characters.' });
      try {
        const user = await createUserAccount({ email, name, role, password });
        return reply.code(201).send(toPublicUser(user));
      } catch (err) {
        if ((err as Error).message === 'email_taken') return reply.code(409).send({ error: 'email_taken' });
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { role?: string; disabled?: boolean; name?: string; password?: string } }>(
    '/api/users/:id',
    { preHandler: requirePermission('manage_users') },
    async (req, reply) => {
      const storage = await getStorage();
      const target = await storage.users.getById(req.params.id);
      if (!target) return reply.code(404).send({ error: 'not_found' });

      const patch: Parameters<typeof storage.users.update>[1] = {};
      if (typeof req.body?.name === 'string') patch.name = req.body.name.trim();
      if (req.body?.role !== undefined) {
        if (!isRole(req.body.role)) return reply.code(400).send({ error: 'invalid_role' });
        patch.role = req.body.role;
      }
      if (typeof req.body?.disabled === 'boolean') patch.disabled = req.body.disabled;
      if (typeof req.body?.password === 'string') {
        if (req.body.password.length < 8) return reply.code(400).send({ error: 'weak_password' });
        patch.password_hash = await hashPassword(req.body.password);
      }

      // Guard: never let the last admin lose admin or be disabled (lock-out).
      const demoting = (patch.role && patch.role !== 'admin') || patch.disabled === true;
      if (target.role === 'admin' && demoting) {
        const users = await storage.users.list();
        const activeAdmins = users.filter((u) => u.role === 'admin' && !u.disabled);
        if (activeAdmins.length <= 1) {
          return reply.code(409).send({ error: 'last_admin', message: 'Cannot demote or disable the last admin.' });
        }
      }

      const updated = await storage.users.update(req.params.id, patch);
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return toPublicUser(updated);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/users/:id',
    { preHandler: requirePermission('manage_users') },
    async (req, reply) => {
      const storage = await getStorage();
      const target = await storage.users.getById(req.params.id);
      if (!target) return reply.code(404).send({ error: 'not_found' });
      if (req.authUser?.id === req.params.id) {
        return reply.code(409).send({ error: 'self_delete', message: 'You cannot delete your own account.' });
      }
      if (target.role === 'admin') {
        const users = await storage.users.list();
        const activeAdmins = users.filter((u) => u.role === 'admin' && !u.disabled);
        if (activeAdmins.length <= 1) {
          return reply.code(409).send({ error: 'last_admin', message: 'Cannot delete the last admin.' });
        }
      }
      await storage.users.remove(req.params.id);
      return { ok: true };
    },
  );

  // ── Connections (Google Drive + Gmail OAuth) ────────────────────────────────
  // Status of every connector, connected or not.
  app.get('/api/connections', { preHandler: requirePermission('view') }, async () => ({
    connections: await connectionStatuses(),
  }));

  // Start an OAuth flow: mint a single-use state and hand back the Google auth URL.
  // The frontend redirects the browser there; Google returns to the callback below.
  app.post<{ Params: { provider: string } }>(
    '/api/connections/:provider/connect',
    { preHandler: requirePermission('manage_connections') },
    async (req, reply) => {
      const provider = req.params.provider;
      if (!isConnectionProvider(provider)) return reply.code(400).send({ error: 'invalid_provider' });
      if (!googleOAuthConfigured()) return reply.code(503).send({ error: 'oauth_not_configured' });
      const url = buildAuthUrl(provider, createState(provider));
      return { url };
    },
  );

  // OAuth redirect target. Hit by the browser (no Bearer token) — protected by the
  // single-use `state`. Exchanges the code, stores tokens, then bounces back to the UI.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/oauth/google/callback',
    async (req, reply) => {
      const back = (status: string, provider = '') =>
        reply.redirect(
          `${appWebUrl()}/?tab=admin&status=${status}${provider ? `&provider=${provider}` : ''}`,
        );

      if (req.query.error) return back('denied');
      const provider = consumeState(req.query.state);
      if (!provider) return back('invalid_state');
      const code = req.query.code;
      if (!code) return back('no_code', provider);

      try {
        const tokens = await exchangeCode(code);
        const email = await fetchUserEmail(tokens.accessToken);
        await saveConnection(provider, tokens, email);
        return back('connected', provider);
      } catch (err) {
        req.log.error({ err }, 'oauth callback failed');
        return back('error', provider);
      }
    },
  );

  // Disconnect: revoke upstream (best effort) and delete the stored tokens.
  app.delete<{ Params: { provider: string } }>(
    '/api/connections/:provider',
    { preHandler: requirePermission('manage_connections') },
    async (req, reply) => {
      const provider = req.params.provider;
      if (!isConnectionProvider(provider)) return reply.code(400).send({ error: 'invalid_provider' });
      const removed = await disconnect(provider);
      if (!removed) return reply.code(404).send({ error: 'not_connected' });
      return { ok: true };
    },
  );

  // ── Google Drive: browse & ingest ───────────────────────────────────────────
  // List a folder's children ('root' by default). Folders first.
  app.get<{ Querystring: { folderId?: string; pageToken?: string } }>(
    '/api/drive/files',
    { preHandler: requirePermission('view') },
    async (req, reply) => {
      const folderId = (req.query.folderId || 'root').trim();
      try {
        return await listFolder(folderId, req.query.pageToken);
      } catch (err) {
        if (err instanceof DriveAuthError) return reply.code(409).send({ error: 'drive_not_connected' });
        req.log.error({ err }, 'drive list failed');
        return reply.code(502).send({ error: 'drive_list_failed', message: (err as Error).message });
      }
    },
  );

  // Search the whole Drive by name (folders + files).
  app.get<{ Querystring: { q?: string } }>(
    '/api/drive/search',
    { preHandler: requirePermission('view') },
    async (req, reply) => {
      const q = (req.query.q || '').trim();
      if (!q) return { files: [] };
      try {
        return { files: await searchFiles(q) };
      } catch (err) {
        if (err instanceof DriveAuthError) return reply.code(409).send({ error: 'drive_not_connected' });
        req.log.error({ err }, 'drive search failed');
        return reply.code(502).send({ error: 'drive_search_failed', message: (err as Error).message });
      }
    },
  );

  // Ingest one or more files into the knowledge base.
  app.post<{ Body: { fileIds?: unknown } }>(
    '/api/drive/ingest',
    { preHandler: requirePermission('run_ingest') },
    async (req, reply) => {
      const raw = req.body?.fileIds;
      const fileIds = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
      if (!fileIds.length) return reply.code(400).send({ error: 'file_ids_required' });
      if (fileIds.length > 50) return reply.code(400).send({ error: 'too_many_files', message: 'Ingest at most 50 files at once.' });
      try {
        const results = await ingestFiles(fileIds);
        return { results };
      } catch (err) {
        if (err instanceof DriveAuthError) return reply.code(409).send({ error: 'drive_not_connected' });
        req.log.error({ err }, 'drive ingest failed');
        return reply.code(502).send({ error: 'drive_ingest_failed', message: (err as Error).message });
      }
    },
  );

  // The catalogue of ingested documents (ingest status view).
  app.get('/api/drive/documents', { preHandler: requirePermission('view') }, async () => {
    const storage = await getStorage();
    return { documents: await storage.documents.list() };
  });

  // Clean reset: delete every Drive-sourced document and its knowledge chunks,
  // then re-sync all folders from scratch through the current (Claude + OCR)
  // pipeline. Drops stale/orphan records and re-extracts every file cleanly.
  app.post('/api/drive/resync-all', { preHandler: requirePermission('run_ingest') }, async (req, reply) => {
    const storage = await getStorage();
    const docs = await storage.documents.list();
    for (const d of docs) {
      if (d.source !== 'google-drive') continue;
      await storage.knowledge.removeByPrefix(docChunkPrefix(d.id));
      await storage.documents.remove(d.id);
    }
    try {
      const folders = await syncAllFolders();
      return { folders };
    } catch (err) {
      if (err instanceof DriveAuthError) return reply.code(409).send({ error: 'drive_not_connected' });
      req.log.error({ err }, 'resync-all failed');
      return reply.code(502).send({ error: 'resync_failed', message: (err as Error).message });
    }
  });

  // Assess the quality of already-stored text for every Drive document (no OCR,
  // no Drive calls) and record 'ok' | 'low' | 'corrupted'. Lets the admin see
  // which documents are garbled before deciding to re-ingest them.
  app.post('/api/drive/documents/assess', { preHandler: requirePermission('run_ingest') }, async () => {
    const storage = await getStorage();
    const docs = await storage.documents.list();
    const counts = { ok: 0, low: 0, corrupted: 0 };
    for (const d of docs) {
      if (d.source !== 'google-drive') continue;
      const text = await storage.knowledge.getTextByPrefix(docChunkPrefix(d.id));
      const quality: TextQuality = looksCorrupted(text) ? 'corrupted' : isLowQualityExtract(text) ? 'low' : 'ok';
      counts[quality]++;
      await storage.documents.upsert({ ...d, text_quality: quality });
    }
    return { assessed: counts.ok + counts.low + counts.corrupted, ...counts };
  });

  // Re-ingest every Drive document whose stored text is flagged 'low' or
  // 'corrupted' — runs OCR on the broken-text-layer PDFs to replace gibberish
  // with clean text. Returns the per-file results.
  app.post('/api/drive/documents/reingest-flagged', { preHandler: requirePermission('run_ingest') }, async (req, reply) => {
    const storage = await getStorage();
    const docs = await storage.documents.list();
    // Retry anything that isn't cleanly ingested: garbled text (low/corrupted)
    // AND docs with no text at all (skipped/failed, e.g. image-only PDFs) so the
    // OCR-enabled pipeline gets another go at them.
    const flagged = docs.filter(
      (d) =>
        d.source === 'google-drive' &&
        (d.text_quality === 'low' ||
          d.text_quality === 'corrupted' ||
          d.status === 'skipped' ||
          d.status === 'failed'),
    );
    if (!flagged.length) return { reingested: 0, results: [] };
    try {
      const results = await ingestFiles(flagged.map((d) => d.id));
      return { reingested: results.length, results };
    } catch (err) {
      if (err instanceof DriveAuthError) return reply.code(409).send({ error: 'drive_not_connected' });
      req.log.error({ err }, 'reingest flagged failed');
      return reply.code(502).send({ error: 'reingest_failed', message: (err as Error).message });
    }
  });

  // Remove an ingested document and its knowledge chunks (Drive or Gmail).
  app.delete<{ Params: { id: string } }>(
    '/api/drive/documents/:id',
    { preHandler: requirePermission('run_ingest') },
    async (req, reply) => {
      const removed = await removeIngestedDocument(req.params.id);
      if (!removed) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  // ── Drive folders selected as knowledge sources ─────────────────────────────
  app.get('/api/drive/folders', { preHandler: requirePermission('view') }, async () => {
    const storage = await getStorage();
    return { folders: await storage.folders.list() };
  });

  // Select a folder as a knowledge source and ingest its contents now.
  app.post<{ Body: { folderId?: string; recursive?: boolean } }>(
    '/api/drive/folders',
    { preHandler: requirePermission('run_ingest') },
    async (req, reply) => {
      const folderId = (req.body?.folderId ?? '').trim();
      if (!folderId) return reply.code(400).send({ error: 'folder_id_required' });
      const recursive = req.body?.recursive !== false; // default true
      try {
        const summary = await addFolderSource(folderId, recursive);
        return summary;
      } catch (err) {
        if (err instanceof DriveAuthError) return reply.code(409).send({ error: 'drive_not_connected' });
        req.log.error({ err }, 'add folder source failed');
        return reply.code(502).send({ error: 'folder_add_failed', message: (err as Error).message });
      }
    },
  );

  // Add several folders as knowledge sources at once (each ingested now).
  app.post<{ Body: { folderIds?: unknown; recursive?: boolean } }>(
    '/api/drive/folders/bulk',
    { preHandler: requirePermission('run_ingest') },
    async (req, reply) => {
      const raw = req.body?.folderIds;
      const folderIds = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
      if (!folderIds.length) return reply.code(400).send({ error: 'folder_ids_required' });
      if (folderIds.length > 25) return reply.code(400).send({ error: 'too_many_folders', message: 'Add at most 25 folders at once.' });
      const recursive = req.body?.recursive !== false; // default true
      try {
        const summaries = await addFolderSources(folderIds, recursive);
        return { folders: summaries };
      } catch (err) {
        if (err instanceof DriveAuthError) return reply.code(409).send({ error: 'drive_not_connected' });
        req.log.error({ err }, 'bulk add folders failed');
        return reply.code(502).send({ error: 'folders_add_failed', message: (err as Error).message });
      }
    },
  );

  // Re-ingest ALL selected folders at once.
  app.post('/api/drive/folders/sync-all', { preHandler: requirePermission('run_ingest') }, async (req, reply) => {
    try {
      return { folders: await syncAllFolders() };
    } catch (err) {
      if (err instanceof DriveAuthError) return reply.code(409).send({ error: 'drive_not_connected' });
      req.log.error({ err }, 'sync all folders failed');
      return reply.code(502).send({ error: 'folders_sync_failed', message: (err as Error).message });
    }
  });

  // Re-ingest a selected folder.
  app.post<{ Params: { id: string } }>(
    '/api/drive/folders/:id/sync',
    { preHandler: requirePermission('run_ingest') },
    async (req, reply) => {
      try {
        const summary = await syncFolderById(req.params.id);
        if (!summary) return reply.code(404).send({ error: 'not_found' });
        return summary;
      } catch (err) {
        if (err instanceof DriveAuthError) return reply.code(409).send({ error: 'drive_not_connected' });
        req.log.error({ err }, 'folder sync failed');
        return reply.code(502).send({ error: 'folder_sync_failed', message: (err as Error).message });
      }
    },
  );

  // Remove a folder source. ?purge=1 also deletes the documents ingested from it.
  app.delete<{ Params: { id: string }; Querystring: { purge?: string } }>(
    '/api/drive/folders/:id',
    { preHandler: requirePermission('run_ingest') },
    async (req, reply) => {
      const purge = req.query.purge === '1' || req.query.purge === 'true';
      const removed = await removeFolderSource(req.params.id, purge);
      if (!removed) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  // ── Gmail: scan a label into the knowledge base ─────────────────────────────
  // The labels the user can pick as a scan source.
  app.get('/api/gmail/labels', { preHandler: requirePermission('view') }, async (req, reply) => {
    try {
      return { labels: await listLabels() };
    } catch (err) {
      if (err instanceof GmailAuthError) return reply.code(409).send({ error: 'gmail_not_connected' });
      req.log.error({ err }, 'gmail labels failed');
      return reply.code(502).send({ error: 'gmail_labels_failed', message: (err as Error).message });
    }
  });

  // Scan a label's messages into the knowledge base (default 200, max 1000).
  app.post<{ Body: { labelId?: string; max?: number } }>(
    '/api/gmail/scan',
    { preHandler: requirePermission('run_ingest') },
    async (req, reply) => {
      const labelId = (req.body?.labelId ?? '').trim();
      if (!labelId) return reply.code(400).send({ error: 'label_id_required' });
      const max = Number.isFinite(req.body?.max) ? Number(req.body?.max) : 200;
      try {
        return await scanLabel(labelId, max);
      } catch (err) {
        if (err instanceof GmailAuthError) return reply.code(409).send({ error: 'gmail_not_connected' });
        req.log.error({ err }, 'gmail scan failed');
        return reply.code(502).send({ error: 'gmail_scan_failed', message: (err as Error).message });
      }
    },
  );
}
