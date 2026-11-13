import type { SolarAlertSettings, AlertResolutionRule } from '@tsba/shared';
import { getStorage } from './storage.js';
import { fetchFileBytes } from './google-drive.js';
import { cached } from './providers/cache.js';
import { getProvider, aggregateStations } from './providers/index.js';
import { faultSolution, anthropicConfigured } from './anthropic.js';
import type { MailAttachment } from './google-gmail.js';
import type { SolarMonitorAlert } from './providers/types.js';

/**
 * Picks a resolution document to attach to an alert email. Admin-defined rules
 * (keyword → KB document) are tried first; if none match and attachments are on,
 * it falls back to automatic knowledge-base retrieval against the issue text,
 * attaching the top hit only when it is lexically relevant. Returns null when
 * nothing confident is found — the email is then sent without an attachment.
 *
 * The original file is re-fetched from Google Drive on demand (the KB stores
 * only extracted text), cached briefly so one guide isn't downloaded repeatedly
 * within a scan. Everything is best-effort: a disconnected Drive or a fetch
 * failure yields null, never a thrown error that could block the alert email.
 */

// Gmail caps a message near 25 MB and base64 inflates ~33%, so skip files whose
// encoded size would get close. 15 MB raw ≈ 20 MB encoded, leaving headroom.
const MAX_ATTACH_BYTES = 15 * 1024 * 1024;
const BYTES_TTL_MS = 600_000;

// Map a monitoring platform to the equipment brand it reports, so the attachment
// and solution are matched to the plant's actual hardware. Multi-brand platforms
// (Solarman aggregates many OEMs) are left out — brand then comes from the device
// model when available, else retrieval runs brand-agnostic.
const PROVIDER_BRAND: Record<string, string> = {
  deye: 'Deye',
  solis: 'Solis',
  goodwe: 'GoodWe',
  growatt: 'Growatt',
  sungrow: 'Sungrow',
  sigen: 'Sigenergy',
  dyness: 'Dyness',
  elekeeper: 'SAJ',
};

/** Does a KB entry's brand match the plant's brand (loose, case-insensitive)? */
function brandMatches(entryBrand: string | undefined, plantBrand: string): boolean {
  const a = (entryBrand ?? '').toLowerCase().trim();
  if (!a) return false;
  const b = plantBrand.toLowerCase();
  return a.includes(b) || b.includes(a);
}

/**
 * Determine the plant's equipment for brand/model-aware retrieval: brand from the
 * platform, and the inverter model from the plant's device list when the provider
 * exposes it (best-effort — a flaky/empty detail call just yields no model).
 */
async function plantEquipment(
  issues: SolarMonitorAlert[],
): Promise<{ brand?: string; model?: string; capacityKw?: number }> {
  const a = issues[0];
  const brand = PROVIDER_BRAND[a.provider];
  let model: string | undefined;
  let capacityKw: number | undefined;
  // Capacity from the reliable fleet overview (used to pick the right-sized guide).
  try {
    const { stations } = await aggregateStations();
    capacityKw = stations.find((x) => x.provider === a.provider && x.id === a.plantId)?.capacityKw;
  } catch {
    /* overview unavailable */
  }
  // Inverter model from the device detail, when the provider exposes it.
  try {
    const provider = getProvider(a.provider);
    if (provider) {
      const detail = await provider.stationDetail(a.plantId);
      const modelItem = detail.info?.find((i) => /model/i.test(i.label));
      const dev = detail.devices.find((d) => /[0-9]/.test(d.type ?? ''));
      model = modelItem?.value || (dev?.type && /[0-9]/.test(dev.type) ? dev.type : undefined);
    }
  } catch {
    /* detail unavailable — brand/capacity still steer retrieval */
  }
  return { brand, model, capacityKw };
}

/** Parse a kW range from a guide title, e.g. "SUN-14K-20K", "10~25K", "8K" → [min,max]. */
function kwRange(title: string): [number, number] | null {
  const m = title.match(/(\d+(?:\.\d+)?)\s*(?:K)?\s*[-~]\s*(\d+(?:\.\d+)?)\s*K/i);
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  const single = title.match(/(\d+(?:\.\d+)?)\s*K(?![\w-]*[-~])/i);
  if (single) return [parseFloat(single[1]), parseFloat(single[1])];
  return null;
}

/**
 * Rank a candidate doc by how well its kW rating fits the plant's capacity: a doc
 * whose range covers the capacity scores highest (tighter range wins the tie);
 * otherwise score by nearest edge. Docs with no parseable rating score neutral.
 */
function capacityFit(title: string, capacityKw?: number): number {
  if (capacityKw == null) return 0;
  const r = kwRange(title);
  if (!r) return -0.5; // unknown rating — slightly deprioritised vs an in-range match
  const [lo, hi] = r;
  if (capacityKw >= lo && capacityKw <= hi) return 100 - (hi - lo); // in range, prefer tighter
  const dist = capacityKw < lo ? lo - capacityKw : capacityKw - hi;
  return -dist; // out of range — closer is better
}

/** Combined lower-cased text of a plant's issues, for keyword/lexical matching. */
function haystack(issues: SolarMonitorAlert[]): string {
  return issues
    .map((i) => `${i.title} ${i.detail ?? ''} ${i.severity} ${i.deviceSn ?? ''}`)
    .join(' ')
    .toLowerCase();
}

/** First rule whose keywords appear in the issue text. */
function matchRule(hay: string, rules: AlertResolutionRule[]): AlertResolutionRule | null {
  for (const r of rules) {
    if (!r.documentId) continue;
    const kws = r.keywords.split(/[,;]+/).map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (kws.length && kws.some((k) => hay.includes(k))) return r;
  }
  return null;
}

/** Build the retrieval query and the terms that gate a confident auto-match. */
function autoQueryAndGate(issues: SolarMonitorAlert[]): { query: string; gate: string[] } {
  const worst = issues[0];
  const base = issues.map((i) => `${i.title} ${i.detail ?? ''}`).join(' ');
  if (worst.severity === 'alert') {
    // A provider fault: lean on the fault name/code.
    return {
      query: `${base} fault error alarm resolution troubleshooting fix`,
      gate: ['fault', 'error', 'alarm', 'code', ...tokens(worst.title)],
    };
  }
  // Offline / partial / device: a connectivity problem (Wi-Fi / logger / network).
  return {
    query: `${base} offline not communicating connection network wifi router datalogger logger stick reconnect troubleshooting`,
    gate: ['offline', 'connect', 'wifi', 'wi-fi', 'network', 'logger', 'communicat', 'reporting', 'signal'],
  };
}

/** Distinctive lower-case word tokens (length ≥ 4), for the lexical gate. */
function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(
    (t) => !['offline', 'plant', 'device', 'station', 'inverter'].includes(t),
  );
}

/** Extract the Drive file id from a KB chunk id like `drive:<fileId>:<n>`. */
function fileIdOf(chunkId: string): string | null {
  if (!chunkId.startsWith('drive:')) return null; // gmail-sourced chunks have no downloadable file
  const rest = chunkId.slice('drive:'.length);
  const id = rest.slice(0, rest.indexOf(':') === -1 ? rest.length : rest.indexOf(':'));
  return id || null;
}

/** Fetch a KB document's bytes as a mail attachment (cached). Null on any failure. */
async function fetchAttachment(documentId: string, titleHint?: string): Promise<MailAttachment | null> {
  try {
    const storage = await getStorage();
    const doc = await storage.documents.get(documentId);
    if (!doc) return null;
    const mime = doc.mime_type || 'application/pdf';
    const { buffer, contentType } = await cached(`resolution:${documentId}`, BYTES_TTL_MS, () =>
      fetchFileBytes(documentId, mime),
    );
    if (buffer.length > MAX_ATTACH_BYTES) return null;
    const title = (doc.title || titleHint || 'resolution').replace(/[\\/:*?"<>|]+/g, '_');
    const filename = /\.(pdf|docx?|txt|csv|xlsx?)$/i.test(title)
      ? title
      : `${title}${contentType === 'application/pdf' ? '.pdf' : ''}`;
    return { filename, content: buffer, contentType };
  } catch {
    return null;
  }
}

/** A human description of the plant's issue, for the solution prompt. */
function issueDescription(issues: SolarMonitorAlert[]): string {
  const worst = issues[0];
  const parts = issues.map((i) => `${i.title}${i.detail ? ` (${i.detail})` : ''}`);
  const device = worst.deviceSn ? `, device ${worst.deviceSn}` : '';
  return `${parts.join('; ')} — plant "${worst.plant}"${device} on ${worst.provider}`;
}

/**
 * Generate a short, KB-grounded resolution for a plant's issue (for the email
 * body, alongside the failure reason). Cached by the issue's fault signature so
 * the same fault across plants / repeat scans isn't re-billed. Returns null when
 * disabled, AI isn't configured, or generation fails.
 */
export async function resolveSolution(
  issues: SolarMonitorAlert[],
  settings: SolarAlertSettings,
): Promise<string | null> {
  if (!settings.includeSolution || !issues.length) return null;

  // Prefer the provider's OWN remediation steps when it supplies them (e.g. SAJ/
  // Elekeeper's `solutions`). These are authoritative, equipment-specific and free,
  // so they take precedence over the AI/KB-generated fallback below. Combine the
  // distinct solutions across this plant's issues (usually one).
  const provided = Array.from(
    new Set(issues.map((i) => i.solution?.trim()).filter((s): s is string => Boolean(s))),
  );
  if (provided.length) return provided.join('\n\n');

  if (!anthropicConfigured()) return null;
  const sigKey = issues.map((i) => i.title.toLowerCase()).join('|');
  try {
    const { brand, model } = await plantEquipment(issues);
    // Equipment is part of the cache key so the same fault on different hardware
    // gets its own (correct) solution.
    const equipKey = `${brand ?? ''}:${model ?? ''}`;
    return await cached(`solution:${equipKey}:${sigKey}`, 24 * 3_600_000, async () => {
      const { query } = autoQueryAndGate(issues);
      let context = '';
      try {
        const storage = await getStorage();
        const hits = await storage.knowledge.retrieve(brand ? `${brand} ${model ?? ''} ${query}` : query, 5, brand, model);
        context = hits
          .map((h) => `[${h.title}] ${h.text}`)
          .join('\n\n')
          .slice(0, 6000); // keep the prompt bounded
      } catch {
        /* no KB / retrieval down — let the model use best practice */
      }
      const equip = [brand, model].filter(Boolean).join(' ');
      const desc = equip ? `${issueDescription(issues)} — equipment: ${equip}` : issueDescription(issues);
      const sol = await faultSolution(desc, context);
      if (!sol) throw new Error('no solution generated'); // don't cache an empty result
      return sol;
    });
  } catch {
    return null;
  }
}

export async function resolveAttachment(
  issues: SolarMonitorAlert[],
  settings: SolarAlertSettings,
): Promise<MailAttachment | null> {
  if (!settings.attachResolution || !issues.length) return null;
  const hay = haystack(issues);

  // 1) Admin rules (first match wins) — the admin chose the doc, so trust it.
  const rule = matchRule(hay, settings.resolutionRules ?? []);
  if (rule) {
    const att = await fetchAttachment(rule.documentId, rule.documentTitle);
    if (att) return att;
    // fall through to auto if the ruled doc couldn't be fetched
  }

  // 2) Automatic, EQUIPMENT-AWARE KB retrieval: match the guide to the plant's
  //    own brand (and model when known) via the KB's brand/model boosting. When
  //    the brand is known we require a brand match so we never attach another
  //    platform's guide; otherwise we fall back to a lexical relevance gate.
  try {
    const storage = await getStorage();
    const { query, gate } = autoQueryAndGate(issues);
    const { brand, model, capacityKw } = await plantEquipment(issues);
    const q = brand ? `${brand} ${model ?? ''} ${query}` : query;
    const hits = await storage.knowledge.retrieve(q, 12, brand, model);

    // Relevant candidates: the plant's brand (or lexical fallback), one per doc.
    const seen = new Set<string>();
    const candidates: { fileId: string; title: string }[] = [];
    for (const hit of hits) {
      const fileId = fileIdOf(hit.id);
      if (!fileId || seen.has(fileId)) continue;
      const text = `${hit.title} ${hit.text}`.toLowerCase();
      const relevant = brand ? brandMatches(hit.brand, brand) : gate.some((g) => text.includes(g));
      if (!relevant) continue;
      seen.add(fileId);
      candidates.push({ fileId, title: hit.title });
    }

    // Prefer the guide whose kW rating covers the plant's capacity (its equipment).
    if (brand && capacityKw != null) {
      candidates.sort((a, b) => capacityFit(b.title, capacityKw) - capacityFit(a.title, capacityKw));
    }

    for (const c of candidates) {
      const att = await fetchAttachment(c.fileId, c.title);
      if (att) return att; // first that fetches under the size cap wins
    }
  } catch {
    /* retrieval unavailable (e.g. memory mode without KB) — skip */
  }
  return null;
}
