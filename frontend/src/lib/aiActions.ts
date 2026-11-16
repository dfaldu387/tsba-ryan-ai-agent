// Prompts for the AI actions launched from monitoring screens. Every result is
// a DRAFT in Drafts & approvals — nothing is sent without human approval.
import type { IngestedDocument } from '@tsba/shared';
import type { SolarStation } from '../api';
import type { AlertGroup } from './alerts';
import { CATEGORY_LABEL } from './alerts';
import { fmtAbs } from './format';

export function fixQuestion(g: AlertGroup, providerName: string): string {
  return [
    `How do I diagnose and fix "${g.fault}"${g.code ? ` (fault code ${g.code})` : ''} on a ${providerName} system?`,
    `Plant: ${g.plant}. Category: ${CATEGORY_LABEL[g.category]}. Seen ${g.count} time${g.count === 1 ? '' : 's'}` +
      (g.firstSeen ? ` since ${fmtAbs(g.firstSeen)}` : '') + '.',
    g.devices.length ? `Device serial(s): ${g.devices.slice(0, 5).join(', ')}.` : '',
    g.solution ? `Provider guidance: ${g.solution.replace(/\s+/g, ' ').slice(0, 600)}` : '',
    'Give step-by-step checks for an installer, flag any AS/NZS 5139 or electrical-safety steps, and cite the manual.',
  ].filter(Boolean).join('\n');
}

export function customerEmailQuestion(g: AlertGroup, providerName: string): string {
  return [
    `Write a short, plain-English email to the owner of the solar plant "${g.plant}" (${providerName}).`,
    `Our monitoring shows: ${g.fault}${g.code ? ` (fault code ${g.code})` : ''}` +
      (g.firstSeen ? `, first seen ${fmtAbs(g.firstSeen)}` : '') + '.',
    'Explain what it means for them, any safe checks they can do themselves (no electrical work), and that TSBA will follow up. Do not quote prices.',
  ].join('\n');
}

export function plantQuestion(s: SolarStation, providerName: string, models: string[], ask: string): string {
  return [
    ask.trim(),
    '',
    `Context — plant "${s.name}" on ${providerName}${s.capacityKw ? `, ${s.capacityKw} kWp` : ''}, status ${s.status}.`,
    models.length ? `Equipment: ${models.join(', ')}.` : '',
  ].filter(Boolean).join('\n');
}

// ─── Knowledge-base document matching ───────────────────────────────────────
export type DocType = 'manual' | 'warranty' | 'datasheet' | 'email' | 'other';
export function docType(d: IngestedDocument): DocType {
  if (d.source === 'gmail') return 'email';
  const t = d.title.toLowerCase();
  if (/warrant/.test(t)) return 'warranty';
  if (/datasheet|data sheet|spec/.test(t)) return 'datasheet';
  if (/manual|guide|install|instruction|quick|user/.test(t)) return 'manual';
  return 'other';
}

const BRAND_ALIASES: Record<string, string[]> = {
  deye: ['deye'], goodwe: ['goodwe', 'sems'], saj: ['saj', 'esolar', 'elekeeper'], solis: ['solis', 'ginlong'],
  sigen: ['sigen', 'sigenergy'], sungrow: ['sungrow'], solarman: ['solarman'], dyness: ['dyness'], growatt: ['growatt'],
  whes: ['whes'], sofar: ['sofar'],
};
export function brandTokens(providerId: string, providerName: string): string[] {
  const k = `${providerId} ${providerName}`.toLowerCase();
  for (const [, aliases] of Object.entries(BRAND_ALIASES)) if (aliases.some((a) => k.includes(a))) return aliases;
  return [providerName.toLowerCase().split(/\s+/)[0]];
}

/** Rank KB docs for a plant/alert: brand match + model tokens + fault words. */
export function matchDocs(docs: IngestedDocument[], opts: { brand: string[]; models?: string[]; words?: string[] }, limit = 6) {
  const models = (opts.models ?? []).flatMap((m) => m.toLowerCase().split(/[\s/,]+/)).filter((t) => t.length >= 3 && /\d/.test(t));
  const words = (opts.words ?? []).map((w) => w.toLowerCase()).filter((w) => w.length >= 4);
  return docs
    .filter((d) => d.source === 'google-drive' && d.status !== 'failed')
    .map((d) => {
      const t = d.title.toLowerCase();
      let score = 0;
      if (opts.brand.some((b) => t.includes(b))) score += 3;
      for (const m of models) if (t.includes(m)) score += 4;
      for (const w of words) if (t.includes(w)) score += 1;
      const type = docType(d);
      if (score > 0 && type === 'manual') score += 1;
      return { d, score, type };
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
