import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  AGENT_PROFILE,
  isAudience,
  isChannel,
  isConnectionProvider,
  isRole,
  type AdminOverview,
  type DraftResult,
  type DraftStatus,
  type SourceCard,
} from '@tsba/shared';
import { cacheLookup, cacheStore, invalidateAnswerCache, isStandaloneQuestion } from '../answer-cache.js';
import { currentUser, issueToken, requireAuth, requirePermission } from '../auth.js';
import { appWebUrl, env, googleOAuthConfigured } from '../env.js';
import {
  PROVIDERS,
  ProviderError,
  ProviderNotConfiguredError,
  aggregateStations,
  configuredProviders,
  getProvider,
} from '../providers/index.js';
import { SOLAR_TOOLS, executeSolarTool, solarToolsAvailable } from '../solar-tools.js';
import { getSolarAlerts } from '../solar-alerts.js';
import { cached as providerCache } from '../providers/cache.js';

// Appended to the chat system prompt when a monitoring platform is connected, so
// the agent knows it can read live plant data (and must not invent figures).
const SOLAR_SYSTEM_NOTE = `

## Live solar monitoring
This console monitors the organisation's solar fleet across several platforms (e.g. Deye, GoodWe, Sungrow). You can read it live with two tools:
- get_solar_overview — every plant across all connected platforms: connected platform names, any unreachable platforms, counts (online/partial/offline), portfolio totals (daily energy, capacity), and per-plant status, current power, today's and total energy, and capacity.
- get_station_detail — one plant by name: status, current power, today/month/total energy, battery SOC, capacity, location, device count with a per-type breakdown (devicesByType — how many batteries/inverters/loggers), how many devices are offline, active alerts/faults, and full plant attributes (coordinates, owner, grid type, commissioning/install dates, income, CO₂, timezone, …).
Use these whenever the user asks anything about a plant/system/site, the fleet, production, status, online/offline, batteries, devices/inverters, or faults — call the right tool and answer only from what it returns. Prefer get_solar_overview for fleet-wide or "which are offline" questions and get_station_detail for a named plant. When summarising, proactively flag offline, partial, or faulting plants and obvious anomalies (e.g. a plant reporting power while marked offline). Never invent numbers; if no plant matches, say so and list the available plant names. You may also explain how these monitoring platforms work in general.`;

// Draft-specific monitoring note. Unlike the chat note it must (a) fit the draft's
// JSON outcome format and (b) explicitly OVERRIDE draft RULE 5 ("hand over anything
// needing live site data") — otherwise the draft agent escalates every plant
// question instead of reading the live data it can now fetch itself.
const SOLAR_DRAFT_NOTE = `

## Live solar monitoring — you CAN read it yourself
TSBA runs live solar monitoring across several platforms (e.g. Deye, GoodWe, Sungrow). You have two tools to read it live:
- get_solar_overview — every plant: connected platforms, online/offline counts, portfolio totals, and per-plant status, current power, today's and total energy, and capacity.
- get_station_detail — one plant by name: status, current power, today/month/total energy, battery SOC, capacity, location, device count with a per-type breakdown (devicesByType — how many batteries/inverters/loggers), how many devices are offline, active alerts/faults, and full plant attributes.

This OVERRIDES RULE 5 and any "hand over anything needing live data" guidance FOR MONITORING DATA. When the question is about a plant/system/site, the fleet, production, status, online/offline, batteries, devices/inverters, battery SOC, or faults shown in monitoring: CALL the right tool and ANSWER from what it returns with outcome "answer". Do NOT hand it to the team, and do NOT ask the customer for the site address when you can look the plant up by name (prefer get_station_detail for a named plant).
- Tool results are live facts you may state directly. They are NOT knowledge-base entries, so leave "sources" empty for any figure that came from monitoring, and say in note_for_ryan that those figures are live monitoring readings (name the plant).
- Never invent numbers. If no plant matches the name, say so (you may list the available plant names) — only then consider "clarify"/"handover". Still use "handover" for things monitoring can't answer (a physical fault needing a site visit, or data not present in monitoring).`;

// Generate an inbox auto-draft with the SAME live monitoring tools the chat/voice
// agent has, so a ticket about a specific plant can be answered with live data —
// not just the knowledge base. Falls back to a plain KB-only draft when no
// monitoring platform is connected. Drafts are human-approved before sending.
function draftReplyWithData(
  prompt: { stable: string; volatile: string },
  signal?: AbortSignal,
): ReturnType<typeof draftReply> {
  if (!solarToolsAvailable()) return draftReply(prompt, signal);
  return draftReply(
    { stable: prompt.stable + SOLAR_DRAFT_NOTE, volatile: prompt.volatile },
    signal,
    { tools: SOLAR_TOOLS, runTool: executeSolarTool },
  );
}
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
import { buildChatSystem, buildPrompt, buildVoiceSystem } from '../prompt.js';
import { offlineChat, offlineDraft } from '../offline-draft.js';
import { detectBrandFromTurns } from '../brand.js';
import { detectModel, detectModelFromTurns } from '../models.js';
import { brandChips, brandFromApp, preClarifyDraft, preClarifyVoice, resolveBrand } from '../disambiguation.js';
import { detectAudience, detectChannel } from '../detect.js';
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
import { GmailAuthError, getMessage, listInbox, listLabels } from '../google-gmail.js';
import { sendReply } from '../smtp-mailer.js';
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
      const rawAudience = req.body?.audience;
      const rawChannel = req.body?.channel;
      // Optional: where an approved reply should be sent. Bounded to a sane length.
      const recipient = (req.body?.recipient ?? '').trim().slice(0, 320) || null;

      if (!question) return reply.code(400).send({ error: 'question_required' });
      // Auto-detect the source when not given (or 'auto'): infer who's asking and
      // the channel from the question itself, so a query needs no manual tagging.
      const audience = isAudience(rawAudience) ? rawAudience : detectAudience(question);
      const channel = isChannel(rawChannel) ? rawChannel : detectChannel(question);
      if (rawAudience != null && rawAudience !== 'auto' && !isAudience(rawAudience)) {
        return reply.code(400).send({ error: 'invalid_audience' });
      }
      if (rawChannel != null && rawChannel !== 'auto' && !isChannel(rawChannel)) {
        return reply.code(400).send({ error: 'invalid_channel' });
      }

      try {
        const storage = await getStorage();

        // Reuse a cached answer for the same question (semantically, when a real
        // embedding provider is configured) so we skip the LLM call. Keyed by
        // audience+channel since both change the wording. Only for live (Claude)
        // drafts — the offline fallback is already cheap and deterministic.
        const cacheKey = `${audience}|${channel}`;
        let result: DraftResult;
        let sources: SourceCard[];

        // Step 3 — identify the inverter brand (named, or implied by an app name).
        const brand = resolveBrand(question);

        // Fast path: a question that can't be answered without knowing the
        // inverter (e.g. "add my inverter to the monitoring app") and no brand
        // yet → return a ready counter-question with no model/retrieval call.
        const preClarify = preClarifyDraft({ question, brand });
        const cached =
          !preClarify && anthropicConfigured()
            ? await cacheLookup<{ result: DraftResult; sources: SourceCard[] }>('draft', cacheKey, question)
            : null;

        if (preClarify) {
          result = preClarify;
          sources = [];
        } else if (cached) {
          result = cached.result;
          sources = cached.sources;
        } else {
          const entries = await storage.knowledge.retrieve(question, env.retrievalTopK, brand, detectModel(question));

          // Use Claude when a key is set; otherwise fall back to an offline draft
          // composed from the retrieved knowledge so the preview still works.
          result = anthropicConfigured()
            ? await draftReplyWithData(buildPrompt({ question, audience, channel, entries }))
            : offlineDraft({ question, audience, channel, entries });

          // Resolve the cited ids into source cards (only ids we actually retrieved).
          const byId = new Map(entries.map((e) => [e.id, e]));
          sources = result.sources
            .map((id) => byId.get(id))
            .filter((e): e is NonNullable<typeof e> => Boolean(e))
            .map((e) => ({ id: e.id, kind: e.kind, title: e.title, source: e.source }));

          if (anthropicConfigured()) await cacheStore('draft', cacheKey, question, { result, sources });
        }

        const draft = await storage.drafts.insert({ question, audience, channel, result, sources, recipient });
        return draft;
      } catch (err) {
        req.log.error({ err }, 'draft failed');
        return reply.code(502).send({ error: 'draft_failed', message: (err as Error).message });
      }
    },
  );

  // ── Voice agent: a natural multi-turn conversation (not a formal draft) ──────
  app.post<{ Body: { messages?: unknown; audience?: string; attachments?: unknown; mode?: string } }>(
    '/api/voice/chat',
    { preHandler: requirePermission('ask') },
    async (req, reply) => {
      // 'text' mode is the live support chat (typed); default 'voice' keeps the
      // voice agent unchanged.
      const mode = req.body?.mode === 'text' ? 'text' : 'voice';
      // Audience may be an explicit value, or 'auto'/absent → infer from the
      // message (the support chat auto-detects who's asking). Reject only a
      // present-but-invalid value.
      const rawAudience = req.body?.audience;
      const explicitAudience = isAudience(rawAudience) ? rawAudience : null;
      if (rawAudience != null && rawAudience !== 'auto' && !explicitAudience) {
        return reply.code(400).send({ error: 'invalid_audience' });
      }

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

        // Auto-detect the "source": who's asking (explicit, else inferred from
        // the latest message) and the channel it reads like. Returned to the
        // client so the support chat can show what it detected.
        const audience = explicitAudience ?? detectAudience(lastUser.content);
        const channel = detectChannel(lastUser.content);

        // Step 3 — brand may have been named (or an app named) earlier in the
        // call, so scan the recent user turns, not just the latest message.
        const userContents = recent.filter((t) => t.role === 'user').map((t) => t.content);
        const brand =
          detectBrandFromTurns(userContents) ?? userContents.map(brandFromApp).find((b) => b) ?? null;

        const OPENING = 'This is an automated response from TSBA Technical Support.';
        const withOpening = (t: string) =>
          t.trimStart().startsWith(OPENING) ? t.trim() : `${OPENING} ${t.trim()}`;

        // Fast path: a monitoring-app question with no inverter named yet → a
        // short counter-question with tappable brand chips, no model call.
        // (Skipped when the turn carries an attachment — that may be the answer.)
        if (attachments.length === 0) {
          const pre =
            mode === 'text'
              ? preClarifyDraft({ question: lastUser.content, brand })
              : preClarifyVoice({ question: lastUser.content, brand });
          if (pre) {
            const suggestions = mode === 'text' ? brandChips() : (pre as { suggestions: string[] }).suggestions;
            return { reply: withOpening(pre.reply), sources: [] as SourceCard[], suggestions, audience, channel };
          }
        }

        // Reuse a cached answer when the same question is asked again. Only for
        // self-contained, attachment-free questions on a live (Claude) setup —
        // context-dependent follow-ups and file questions always go to the model.
        const cacheable =
          anthropicConfigured() && attachments.length === 0 && isStandaloneQuestion(lastUser.content);
        if (cacheable) {
          const hit = await cacheLookup<{ reply: string; sources: SourceCard[]; suggestions: string[] }>(
            'voice',
            audience,
            lastUser.content,
          );
          if (hit) return { ...hit, audience, channel };
        }

        // Retrieval query: use the recent USER turns, not just the latest message.
        // A follow-up reply like "I have a Deye" carries no topic words of its own,
        // so on its own it retrieves generic brand datasheets and the entry that
        // actually answers the thread (e.g. APP-DEYE, "add to the SOLARMAN app")
        // never reaches the top-K — making the model hand over an answerable
        // question. Carrying the earlier turns ("...add my inverter to the
        // monitoring app") into the query keeps the real topic in scope.
        const retrievalQuery = userContents.slice(-3).join('\n').slice(-2000);
        // A specific model named anywhere in the thread grounds the answer in that
        // model's own document (per-model guides), not a generic brand-level note.
        const model = detectModelFromTurns(userContents);
        const entries = await storage.knowledge.retrieve(retrievalQuery, env.retrievalTopK, brand, model);

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

        const baseSystem =
          mode === 'text'
            ? buildChatSystem({ audience, channel, entries })
            : buildVoiceSystem({ audience, entries });
        // When a monitoring platform is connected, give the agent the live-data
        // tools and tell it (in the system prompt) how/when to use them.
        const solarOn = solarToolsAvailable();
        const system = solarOn
          ? { stable: baseSystem.stable + SOLAR_SYSTEM_NOTE, volatile: baseSystem.volatile }
          : baseSystem;
        const text = anthropicConfigured()
          ? await chatReply(
              system,
              modelTurns,
              undefined,
              solarOn ? { tools: SOLAR_TOOLS, runTool: executeSolarTool } : undefined,
            )
          : offlineChat({ question: lastUser.content, audience, entries });

        // Guarantee the client's mandated opening line, even if the model omits it.
        const reply = withOpening(text);

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

        const payload = { reply, sources, suggestions };
        if (cacheable) await cacheStore('voice', audience, lastUser.content, payload);
        return { ...payload, audience, channel };
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

  // ── Gmail inbox as the query list ───────────────────────────────────────────
  // List recent inbox messages as end-user queries (lightweight, no LLM).
  app.get<{ Querystring: { labelId?: string; max?: string } }>(
    '/api/gmail/queries',
    { preHandler: requirePermission('ask') },
    async (req, reply) => {
      const labelId = (req.query?.labelId || 'INBOX').trim();
      const max = Math.min(100, Math.max(1, Number(req.query?.max) || 30));
      try {
        return { queries: await listInbox(labelId, max) };
      } catch (err) {
        if (err instanceof GmailAuthError) return reply.code(409).send({ error: 'gmail_not_connected' });
        req.log.error({ err }, 'gmail queries failed');
        return reply.code(502).send({ error: 'gmail_queries_failed', message: (err as Error).message });
      }
    },
  );

  // Draft a grounded reply for one inbox message. Auto-detects who's asking;
  // channel is 'email' (it came from Gmail).
  app.post<{ Params: { id: string } }>(
    '/api/gmail/queries/:id/draft',
    { preHandler: requirePermission('ask') },
    async (req, reply) => {
      try {
        const msg = await getMessage(req.params.id);
        const question = `${msg.subject}\n\n${msg.text}`.trim().slice(0, 6000);
        const audience = detectAudience(question);
        const channel = 'email' as const;
        const storage = await getStorage();

        const brand = resolveBrand(question);
        const pre = preClarifyDraft({ question, brand });
        let result: DraftResult;
        let sources: SourceCard[];
        if (pre) {
          result = pre;
          sources = [];
        } else {
          const entries = await storage.knowledge.retrieve(question, env.retrievalTopK, brand, detectModel(question));
          result = anthropicConfigured()
            ? await draftReplyWithData(buildPrompt({ question, audience, channel, entries }))
            : offlineDraft({ question, audience, channel, entries });
          const byId = new Map(entries.map((e) => [e.id, e]));
          sources = result.sources
            .map((id) => byId.get(id))
            .filter((e): e is NonNullable<typeof e> => Boolean(e))
            .map((e) => ({ id: e.id, kind: e.kind, title: e.title, source: e.source }));
        }
        return { audience, channel, from: msg.from, subject: msg.subject, result, sources };
      } catch (err) {
        if (err instanceof GmailAuthError) return reply.code(409).send({ error: 'gmail_not_connected' });
        req.log.error({ err }, 'gmail draft failed');
        return reply.code(502).send({ error: 'gmail_draft_failed', message: (err as Error).message });
      }
    },
  );

  // Send a reply back to the message's thread (the explicit "send" action).
  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    '/api/gmail/queries/:id/reply',
    { preHandler: requirePermission('approve_drafts') },
    async (req, reply) => {
      const text = (req.body?.text ?? '').trim();
      if (!text) return reply.code(400).send({ error: 'text_required' });
      try {
        const msg = await getMessage(req.params.id);
        const sent = await sendReply({
          to: msg.from,
          subject: msg.subject,
          body: text,
          threadId: msg.threadId,
          inReplyTo: msg.messageId,
        });
        return { ok: true, ...sent };
      } catch (err) {
        if (err instanceof GmailAuthError) return reply.code(409).send({ error: 'gmail_not_connected' });
        req.log.error({ err }, 'gmail reply failed');
        return reply.code(502).send({ error: 'gmail_reply_failed', message: (err as Error).message });
      }
    },
  );

  // ── Solar monitoring (multi-provider: Deye, GoodWe, …) ──────────────────────
  // Shared error mapping: not-configured → 503, anything else → 502. All provider
  // credentials (app secrets, passwords) stay strictly server-side.
  const solarFail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ProviderNotConfiguredError) return reply.code(503).send({ error: 'provider_not_configured' });
    const code = err instanceof ProviderError ? err.code : undefined;
    return reply.code(502).send({ error: 'provider_request_failed', code, message: (err as Error).message });
  };

  // The list of providers and whether each is connected (no secrets returned).
  app.get('/api/solar/providers', { preHandler: requirePermission('view') }, async () => ({
    providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, configured: p.configured() })),
  }));

  // Aggregated overview: every station across every configured provider, queried
  // in parallel and resiliently (one retry + last-good fallback per provider), so
  // a transient blip on one platform neither blanks it nor flashes an error.
  app.get('/api/solar/overview', { preHandler: requirePermission('view') }, async () => {
    const { stations, errors, stale, unavailable } = await aggregateStations();
    return { stations, errors, stale, unavailable, providerCount: configuredProviders().length };
  });

  // Fleet health alerts for the header notification panel: offline/partial
  // plants, disconnected devices and active faults across all platforms. The
  // underlying fleet-wide detail scan is cached (~2 min), so this stays cheap
  // even when several admins poll it.
  app.get('/api/solar/alerts', { preHandler: requirePermission('view') }, async (req, reply) => {
    try {
      return await getSolarAlerts();
    } catch (err) {
      req.log.error({ err }, 'solar alerts scan failed');
      console.error('[solar/alerts] scan failed:', (err as Error).stack || err);
      return reply.code(500).send({ error: 'solar_alerts_failed', detail: (err as Error).message });
    }
  });

  // One station's detail bundle (realtime, devices, alerts, today's power curve)
  // from a specific provider.
  app.get<{ Params: { provider: string; id: string } }>(
    '/api/solar/:provider/stations/:id/detail',
    { preHandler: requirePermission('view') },
    async (req, reply) => {
      const provider = getProvider(req.params.provider);
      if (!provider) return reply.code(404).send({ error: 'unknown_provider' });
      if (!provider.configured()) return reply.code(503).send({ error: 'provider_not_configured' });
      try {
        let detail;
        try {
          detail = await provider.stationDetail(req.params.id);
        } catch {
          // One retry — covers a transient upstream blip or a just-expired token.
          await new Promise((r) => setTimeout(r, 400));
          detail = await provider.stationDetail(req.params.id);
        }
        return { provider: provider.id, stationId: req.params.id, ...detail };
      } catch (err) {
        req.log.error({ err, provider: provider.id }, 'solar station detail failed');
        return solarFail(reply, err);
      }
    },
  );

  // Rich "Overview" dashboard data (energy flow, KPI cards, curve analysis,
  // power/energy charts, environmental). Only providers that implement
  // provider.overview() return data; others yield 501 so the UI shows the basic
  // detail instead. Cached briefly so repeated opens don't re-hit the platform.
  app.get<{ Params: { provider: string; id: string } }>(
    '/api/solar/:provider/stations/:id/overview',
    { preHandler: requirePermission('view') },
    async (req, reply) => {
      const provider = getProvider(req.params.provider);
      if (!provider) return reply.code(404).send({ error: 'unknown_provider' });
      if (!provider.configured()) return reply.code(503).send({ error: 'provider_not_configured' });
      if (!provider.overview) return reply.code(501).send({ error: 'overview_unsupported' });
      try {
        const overview = await providerCache(
          `solar:overview:${provider.id}:${req.params.id}`,
          60_000,
          () => provider.overview!(req.params.id),
        );
        return { provider: provider.id, stationId: req.params.id, ...overview };
      } catch (err) {
        req.log.error({ err, provider: provider.id }, 'solar station overview failed');
        return solarFail(reply, err);
      }
    },
  );

  // ── Persisted history (from the solar snapshot recorder) ────────────────────

  // Monthly fleet production (kWh) derived from stored lifetime-total snapshots.
  app.get<{ Querystring: { months?: string } }>(
    '/api/solar/history/monthly',
    { preHandler: requirePermission('view') },
    async (req) => {
      const months = Math.min(36, Math.max(1, Number(req.query.months) || 6));
      const storage = await getStorage();
      return { months: await storage.solar.monthlyProduction(months) };
    },
  );

  // Fleet aggregate snapshots over a recent window (for power/status trends).
  app.get<{ Querystring: { hours?: string } }>(
    '/api/solar/history/fleet',
    { preHandler: requirePermission('view') },
    async (req) => {
      const hours = Math.min(24 * 90, Math.max(1, Number(req.query.hours) || 24));
      const storage = await getStorage();
      return { readings: await storage.solar.fleetHistory(Date.now() - hours * 3_600_000) };
    },
  );

  // Force a snapshot now (otherwise written on the recorder's interval).
  app.post('/api/solar/snapshot', { preHandler: requirePermission('ask') }, async () => {
    const { captureSolarSnapshot } = await import('../solar-recorder.js');
    const res = await captureSolarSnapshot();
    return { recorded: res != null, stations: res?.stations ?? 0 };
  });

  // ── Alert settings (admin-editable, stored in the DB) ──────────────────────

  // Current alert configuration (recipients, interval, delays, quiet hours, …).
  app.get('/api/solar/alerts/settings', { preHandler: requirePermission('view') }, async () => {
    const { getAlertSettings } = await import('../solar-alert-settings.js');
    return { settings: await getAlertSettings() };
  });

  // Update the alert configuration. Validated + merged server-side; the monitor
  // picks up the change on its next scan. Managers/admins only.
  app.put<{ Body: Partial<import('@tsba/shared').SolarAlertSettings> }>(
    '/api/solar/alerts/settings',
    { preHandler: requirePermission('manage_connections') },
    async (req, reply) => {
      const { saveAlertSettings } = await import('../solar-alert-settings.js');
      try {
        return { settings: await saveAlertSettings(req.body ?? {}) };
      } catch (err) {
        return reply.code(400).send({ error: 'invalid_settings', detail: (err as Error).message });
      }
    },
  );

  // ── Per-plant owner/contact store (admin-maintained) ──────────────────────

  app.get('/api/solar/plant-contacts', { preHandler: requirePermission('view') }, async () => {
    const { getPlantContacts } = await import('../plant-contacts.js');
    return { contacts: await getPlantContacts() };
  });

  app.put<{ Body: { contacts?: import('@tsba/shared').PlantContacts } }>(
    '/api/solar/plant-contacts',
    { preHandler: requirePermission('manage_connections') },
    async (req, reply) => {
      const { savePlantContacts } = await import('../plant-contacts.js');
      try {
        return { contacts: await savePlantContacts(req.body?.contacts ?? {}) };
      } catch (err) {
        return reply.code(400).send({ error: 'invalid_contacts', detail: (err as Error).message });
      }
    },
  );

  // Run the alert monitor now (scan → de-dupe → email due issues / recoveries).
  // Returns what the pass did. `?test=1` instead sends a one-off sample email to
  // the configured admin recipients, to verify the Gmail wiring without waiting
  // for a real outage.
  app.post<{ Querystring: { test?: string; to?: string } }>(
    '/api/solar/alerts/run',
    { preHandler: requirePermission('ask') },
    async (req, reply) => {
      // Send a REAL alert email from an actual current fleet issue (real plant,
      // owner details, reason + resolution attachment), for previewing.
      if (req.query.test === 'digest') {
        const { sendSampleDigest } = await import('../solar-alert-monitor.js');
        const { MailSendError } = await import('../smtp-mailer.js');
        try {
          return await sendSampleDigest();
        } catch (err) {
          const isSmtp = err instanceof MailSendError;
          return reply
            .code(isSmtp ? 503 : 502)
            .send({ sent: false, error: isSmtp ? 'smtp_not_configured' : 'send_failed', detail: (err as Error).message });
        }
      }
      if (req.query.test === 'real') {
        const { sendSampleAlert } = await import('../solar-alert-monitor.js');
        const { MailSendError } = await import('../smtp-mailer.js');
        try {
          return await sendSampleAlert();
        } catch (err) {
          const isSmtp = err instanceof MailSendError;
          return reply
            .code(isSmtp ? 503 : 502)
            .send({ sent: false, error: isSmtp ? 'smtp_not_configured' : 'send_failed', detail: (err as Error).message });
        }
      }
      if (req.query.test === '1' || req.query.test === 'true') {
        // Recipients default to the configured admin list, but an optional `?to=`
        // override lets ops send a one-off test to any address.
        let recipients: string[];
        if (req.query.to && req.query.to.trim()) {
          recipients = req.query.to.split(',').map((s) => s.trim()).filter(Boolean);
        } else {
          const { getAlertSettings } = await import('../solar-alert-settings.js');
          recipients = (await getAlertSettings()).admin.recipients;
        }
        if (!recipients.length)
          return reply.code(400).send({ error: 'no_recipient', detail: 'No recipient configured (set admin recipients or pass ?to=).' });
        const { sendMail, MailSendError } = await import('../smtp-mailer.js');
        try {
          await sendMail({
            to: recipients.join(', '),
            subject: '[Solar Alert] Test notification',
            text: 'This is a test alert from the TSBA solar monitoring system. If you received it, email alerts are wired up correctly.',
            html: '<p>This is a <strong>test alert</strong> from the TSBA solar monitoring system.</p><p>If you received it, email alerts are wired up correctly.</p>',
          });
          return { test: true, sent: true, recipients };
        } catch (err) {
          const isSmtp = err instanceof MailSendError;
          return reply
            .code(isSmtp ? 503 : 502)
            .send({ test: true, sent: false, error: isSmtp ? 'smtp_not_configured' : 'send_failed', detail: (err as Error).message });
        }
      }
      const { runAlertMonitorOnce } = await import('../solar-alert-monitor.js');
      return runAlertMonitorOnce();
    },
  );
}
