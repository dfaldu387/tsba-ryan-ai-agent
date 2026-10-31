// ─── Model-level grounding ───────────────────────────────────────────────────
// Brand alone often isn't enough: a brand typically has many models, each with
// its own document (e.g. per-model installation guides). To answer precisely we
// detect the specific MODEL the person named — anywhere in the conversation —
// and then boost that model's document in retrieval so the reply is grounded in
// the right guide rather than a generic brand-level note.
//
// This is brand-agnostic on purpose: it reads a model CODE out of free text by
// shape (letters + digits, usually hyphenated), so it works for Deye SUN-… ,
// Solis S6-… , GoodWe GW… , Sungrow SG… , etc. without a per-brand list.

// A model-code token: starts with a letter, at least 4 chars, and contains BOTH
// a letter and a digit, allowing '-' and '.' inside (SUN-8K-SG05LP1-AU,
// AI-W5.1-B-ESS, S6-GC25K, GW5000-EH, SG5.0RS). The lookaheads require the
// letter+digit mix so plain words ("inverter") and bare numbers ("5kW") don't match.
const MODEL_RE = /\b(?=[A-Za-z0-9.\-]*[A-Za-z])(?=[A-Za-z0-9.\-]*\d)[A-Za-z][A-Za-z0-9.\-]{3,}\b/g;

/** Strip everything but letters/digits and lowercase — so "SUN-8K-SG05LP1-AU" ≈ "sun 8k sg05lp1 au". */
function normalizeCode(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The most specific model code named in a piece of text, or null. "Most specific"
 * = the longest matching token, so "SUN-8K-SG05LP1-AU" wins over a bare "SG05LP1".
 */
export function detectModel(text: string): string | null {
  if (!text) return null;
  const matches = text.match(MODEL_RE);
  if (!matches || !matches.length) return null;
  // Longest normalized code is the most discriminating one.
  return matches.slice().sort((a, b) => normalizeCode(b).length - normalizeCode(a).length)[0];
}

/**
 * Detect the model from a conversation, scanning most-recent user turns first so
 * a model named earlier still counts, while a later, more specific mention wins.
 */
export function detectModelFromTurns(contents: string[]): string | null {
  for (let i = contents.length - 1; i >= 0; i--) {
    const m = detectModel(contents[i]);
    if (m) return m;
  }
  return null;
}

/**
 * Drop query terms that are part of the named model code. The model is already
 * applied as a retrieval bonus, so letting its (very high-IDF) code tokens also
 * dominate the lexical score double-counts it and buries entries that match the
 * QUESTION TOPIC but not the code (e.g. a "monitoring app" how-to). Removing them
 * lets topic words drive the lexical rank while the bonus handles model matching.
 */
export function stripModelTerms(terms: string[], model: string | null | undefined): string[] {
  if (!model) return terms;
  const code = normalizeCode(model);
  if (code.length < 4) return terms;
  return terms.filter((t) => {
    const nt = normalizeCode(t);
    return !(nt.length >= 2 && code.includes(nt));
  });
}

/**
 * True when a knowledge entry belongs to the named model. The model code lives in
 * the entry's title (TSBA filenames follow "BRAND MODEL | …") or its model field,
 * so we normalize both sides and test containment. Needs a reasonably specific
 * code (≥5 normalized chars) so a short fragment can't match half the catalogue.
 */
export function modelMatches(entry: { title?: string; model?: string }, model: string | null | undefined): boolean {
  if (!model) return false;
  const needle = normalizeCode(model);
  if (needle.length < 5) return false;
  const hay = normalizeCode(`${entry.model ?? ''} ${entry.title ?? ''}`);
  return hay.includes(needle);
}
