// HTTP API for the sales follow-up agent, mounted under /api/kw.
// Rep endpoints need the `sales` permission and only touch the caller's rows.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { KW_TONES, type KwMix, type KwProfile, type KwStatus, type KwTextType, type KwTone } from '@tsba/shared';
import { requirePermission } from '../auth.js';
import { env } from '../env.js';
import { aiConfigured, extractNotes, understandBusiness } from './ai.js';
import * as repo from './repo.js';
import * as svc from './service.js';
import { defaultFrom, smsMode, validTwilioSignature } from './sms.js';
import { QUIET } from './time.js';
import { loadSettings, saveSettings, settings } from './settings.js';
import { allClients, allMessages, optOuts } from './admin.js';
import * as agent from './agent.js';
import { listActivity } from './activity.js';
import * as convo from './conversation.js';

const sales = { preHandler: requirePermission('sales') };
const uid = (req: FastifyRequest): string => req.authUser!.id;

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof svc.KwError) return reply.code(err.status).send({ error: 'keepwarm', message: err.message });
  console.error('[keepwarm]', err);
  return reply.code(500).send({ error: 'keepwarm', message: 'Something went wrong. Try again.' });
}

/** Wrap a handler that needs the rep's profile. */
function withProfile<T>(fn: (p: repo.StoredProfile, req: FastifyRequest) => Promise<T>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(await svc.requireProfile(uid(req)), req);
    } catch (err) {
      return fail(reply, err);
    }
  };
}

const isType = (v: unknown): v is KwTextType => v === 'business' || v === 'friendly';
const isMix = (v: unknown): v is KwMix => v === 'business' || v === 'friendly' || v === 'mix';
const isTone = (v: unknown): v is KwTone => KW_TONES.some((t) => t.id === v);

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function registerKeepwarmRoutes(app: FastifyInstance): Promise<void> {
  await loadSettings();

  // ── Status + setup ──────────────────────────────────────────────────────
  app.get('/api/kw/status', sales, async (req): Promise<KwStatus> => {
    const p = await repo.getProfile(uid(req));
    const profile: KwProfile | null = p
      ? { displayName: p.displayName, company: p.company, signOff: p.signOff, about: p.about, understood: p.understood, tone: p.tone, sendTime: p.sendTime, timezone: p.timezone }
      : null;
    return {
      profile,
      sms: { mode: smsMode(), from: p?.smsFrom || defaultFrom() },
      ai: aiConfigured(),
      quietHours: { start: QUIET.start, end: QUIET.end, sunday: QUIET.sunday },
      targets: settings().targets,
      agentMode: settings().agentMode,
      autoReply: settings().autoReply,
    };
  });

  app.post<{ Body: { about?: string; company?: string } }>('/api/kw/understand', sales, async (req, reply) => {
    const about = (req.body?.about ?? '').trim();
    if (about.length < 10) return reply.code(400).send({ error: 'keepwarm', message: 'Tell me a bit more about your business.' });
    return understandBusiness(about.slice(0, 4000), (req.body?.company ?? 'TSBA').trim() || 'TSBA');
  });

  app.put<{ Body: Partial<KwProfile> }>('/api/kw/profile', sales, async (req, reply) => {
    const b = req.body ?? {};
    const displayName = (b.displayName ?? '').trim();
    const signOff = (b.signOff ?? '').trim() || displayName.split(/\s+/)[0];
    if (!displayName) return reply.code(400).send({ error: 'keepwarm', message: 'Your name is needed. Clients see it on every text.' });
    const existing = await repo.getProfile(uid(req));
    const tz = b.timezone && validTz(b.timezone) ? b.timezone : existing?.timezone ?? 'Australia/Sydney';
    const saved = await repo.upsertProfile(uid(req), {
      displayName,
      company: (b.company ?? 'TSBA').trim() || 'TSBA',
      signOff,
      about: (b.about ?? existing?.about ?? '').trim().slice(0, 4000),
      understood: b.understood ?? existing?.understood ?? null,
      tone: isTone(b.tone) ? b.tone : existing?.tone ?? 'friendly',
      sendTime: b.sendTime && /^\d{1,2}:\d{2}$/.test(b.sendTime) ? b.sendTime : existing?.sendTime ?? '09:00',
      timezone: tz,
    });
    return { ok: true, profile: saved };
  });

  // ── Today ───────────────────────────────────────────────────────────────
  app.get('/api/kw/today', sales, withProfile((p) => svc.today(p)));

  // ── Clients ─────────────────────────────────────────────────────────────
  app.get('/api/kw/clients', sales, withProfile(async (p) => ({ clients: (await repo.listClients(p.userId, p.timezone)).map(svc.publicClient) })));

  app.post('/api/kw/clients', sales, withProfile((p, req) => svc.addClient(p, (req.body ?? {}) as Record<string, string>)));

  app.get<{ Params: { id: string } }>('/api/kw/clients/:id', sales, withProfile((p, req) => svc.clientDetail(p, (req.params as { id: string }).id)));

  app.patch<{ Params: { id: string } }>('/api/kw/clients/:id', sales, withProfile((p, req) => {
    const b = (req.body ?? {}) as svc.ClientUpdate;
    if (b.mix !== undefined && !isMix(b.mix)) throw new svc.KwError('Invalid follow-up type');
    return svc.updateClient(p, (req.params as { id: string }).id, b);
  }));

  app.delete<{ Params: { id: string } }>('/api/kw/clients/:id', sales, withProfile(async (p, req) => {
    await svc.removeClient(p, (req.params as { id: string }).id);
    return { ok: true };
  }));

  /** Voice note (transcribed in the browser) → sorted notes + suggested rhythm. Not saved until the rep confirms. */
  app.post<{ Params: { id: string } }>('/api/kw/clients/:id/understand', sales, withProfile(async (p, req) => {
    const c = await repo.getClient(p.userId, (req.params as { id: string }).id, p.timezone);
    if (!c) throw new svc.KwError('Client not found', 404);
    const transcript = String((req.body as { transcript?: string })?.transcript ?? '').trim();
    if (transcript.length < 5) throw new svc.KwError('Say a bit about the meeting first');
    return extractNotes(transcript.slice(0, 6000), p, c.name);
  }));

  app.post<{ Params: { id: string } }>('/api/kw/clients/:id/compose', sales, withProfile((p, req) => {
    const b = (req.body ?? {}) as { type?: string; instruction?: string };
    return svc.composeFor(p, (req.params as { id: string }).id, { type: isType(b.type) ? b.type : undefined, instruction: b.instruction });
  }));

  app.post<{ Params: { id: string } }>('/api/kw/clients/:id/simulate-reply', sales, withProfile(async (p, req) => {
    await svc.simulateReply(p, (req.params as { id: string }).id, String((req.body as { text?: string })?.text ?? ''));
    return { ok: true };
  }));

  // ── Review a draft ──────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/api/kw/messages/:id/rewrite', sales, withProfile((p, req) => {
    const b = (req.body ?? {}) as { type?: string; instruction?: string; shorter?: boolean; another?: boolean; current?: string };
    return svc.rewrite(p, (req.params as { id: string }).id, {
      type: isType(b.type) ? b.type : undefined,
      instruction: typeof b.instruction === 'string' ? b.instruction.slice(0, 500) : undefined,
      shorter: !!b.shorter,
      another: !!b.another,
      current: typeof b.current === 'string' ? b.current : undefined,
    });
  }));

  app.post<{ Params: { id: string } }>('/api/kw/messages/:id/approve', sales, withProfile((p, req) => {
    const b = (req.body ?? {}) as { text?: string; type?: string };
    return svc.approve(p, (req.params as { id: string }).id, { text: b.text, type: isType(b.type) ? b.type : undefined });
  }));

  app.post<{ Params: { id: string } }>('/api/kw/messages/:id/snooze', sales, withProfile(async (p, req) => {
    await svc.snooze(p, (req.params as { id: string }).id, Number((req.body as { days?: number })?.days ?? 1));
    return { ok: true };
  }));

  app.post<{ Params: { id: string } }>('/api/kw/messages/:id/skip', sales, withProfile(async (p, req) => {
    await svc.skip(p, (req.params as { id: string }).id);
    return { ok: true };
  }));

  app.post<{ Params: { id: string } }>('/api/kw/messages/:id/unschedule', sales, withProfile((p, req) => svc.unschedule(p, (req.params as { id: string }).id)));

  // ── Pipeline agent ──────────────────────────────────────────────────────
  app.get('/api/kw/agent', sales, withProfile((p) => agent.state(p)));
  app.post('/api/kw/agent/run', sales, withProfile((p) => agent.runNow(p)));
  app.post<{ Params: { id: string } }>('/api/kw/agent/tasks/:id/accept', sales, withProfile((p, req) =>
    agent.accept(p, (req.params as { id: string }).id, (req.body ?? {}) as agent.AcceptBody)));
  app.post<{ Params: { id: string } }>('/api/kw/agent/tasks/:id/dismiss', sales, withProfile(async (p, req) => {
    await agent.dismiss(p, (req.params as { id: string }).id, Number((req.body as { days?: number })?.days ?? 7));
    return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/kw/agent/activity/:id/undo', sales, withProfile(async (p, req) => {
    await agent.undo(p, (req.params as { id: string }).id);
    return { ok: true };
  }));
  app.get<{ Params: { id: string } }>('/api/kw/clients/:id/activity', sales, withProfile(async (p, req) => {
    const id = (req.params as { id: string }).id;
    return { activity: await listActivity(p.userId, { clientId: id, limit: 50 }), tasks: await agent.openTasks(p.userId, id) };
  }));

  // ── Conversation control: agent ⇄ rep ───────────────────────────────────
  const clientFor = async (p: repo.StoredProfile, req: FastifyRequest) => {
    const c = await repo.getClient(p.userId, (req.params as { id: string }).id, p.timezone);
    if (!c) throw new svc.KwError('Client not found', 404);
    return c;
  };
  app.post<{ Params: { id: string } }>('/api/kw/clients/:id/takeover', sales, withProfile(async (p, req) => {
    const c = await clientFor(p, req);
    await convo.takeOver(p, c, 'You tapped Take over');
    await agent.closeFor(c.id, ['handback']);
    return svc.publicClient((await repo.getClient(p.userId, c.id, p.timezone))!);
  }));
  app.post<{ Params: { id: string } }>('/api/kw/clients/:id/handback', sales, withProfile(async (p, req) => {
    const c = await clientFor(p, req);
    if (c.convo !== 'rep') throw new svc.KwError('You aren’t handling this conversation', 409);
    if (c.paused) throw new svc.KwError(`${c.name} is waiting on your answer. Reply first, then hand back.`, 409);
    const r = await convo.handBack(p, c, String((req.body as { note?: string })?.note ?? '').slice(0, 200));
    await agent.closeFor(c.id, ['handback']);
    return { ...r, client: svc.publicClient((await repo.getClient(p.userId, c.id, p.timezone))!) };
  }));
  app.post<{ Params: { id: string } }>('/api/kw/clients/:id/typing', sales, withProfile(async (p, req) => convo.typing(p, await clientFor(p, req))));

  // ── Scoreboard ──────────────────────────────────────────────────────────
  app.get<{ Querystring: { range?: string } }>('/api/kw/score', sales, withProfile((p, req) =>
    svc.scoreboard(p, (req.query as { range?: string }).range === 'week' ? 'week' : 'day')));

  app.post('/api/kw/score', sales, withProfile((p, req) => {
    const b = (req.body ?? {}) as { metric?: string; delta?: number };
    return svc.logScore(p, String(b.metric ?? ''), Number(b.delta ?? 0));
  }));

  app.post('/api/kw/score/voice', sales, withProfile((p, req) => svc.logScoreByVoice(p, String((req.body as { text?: string })?.text ?? '').slice(0, 1000))));

  // ── Team (managers) ─────────────────────────────────────────────────────
  const team = { preHandler: requirePermission('sales_team') };
  app.get('/api/kw/team', team, async () => ({ reps: await svc.team() }));

  // ── Sales admin ─────────────────────────────────────────────────────────
  app.get('/api/kw/admin/pipeline', team, async () => ({ clients: await allClients() }));

  app.get<{ Querystring: { status?: string; direction?: string; rep?: string; q?: string; limit?: string } }>(
    '/api/kw/admin/messages', team, async (req) => {
      const q = req.query;
      return { messages: await allMessages({ status: q.status, direction: q.direction, repId: q.rep, q: q.q, limit: Number(q.limit) || undefined }) };
    },
  );

  app.get('/api/kw/admin/optouts', team, async () => ({ optOuts: await optOuts() }));

  app.get('/api/kw/admin/settings', team, async () => ({
    settings: settings(),
    sms: { mode: smsMode(), from: defaultFrom() },
    ai: aiConfigured(),
  }));

  app.put('/api/kw/admin/settings', team, async (req) => ({ settings: await saveSettings((req.body ?? {}) as Record<string, never>) }));

  // ── Inbound SMS webhook (Twilio, form-encoded, public but signed) ───────
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    scope.post('/api/kw/sms/inbound', async (req, reply) => {
      const params = (req.body ?? {}) as Record<string, string>;
      const base = process.env.KW_PUBLIC_URL || env.webOrigin;
      const url = `${base.replace(/\/$/, '')}/api/kw/sms/inbound`;
      if (smsMode() !== 'twilio' || !validTwilioSignature(url, params, req.headers['x-twilio-signature'] as string | undefined)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      try {
        await svc.inbound(params.From ?? '', params.Body ?? '');
      } catch (err) {
        console.error('[keepwarm] inbound failed:', err);
      }
      // Empty TwiML: no auto-reply. The rep answers, in their own words.
      return reply.type('text/xml').send('<Response></Response>');
    });
  });
}
