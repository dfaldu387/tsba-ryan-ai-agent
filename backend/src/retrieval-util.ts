// Shared retrieval helpers (no DB dependency) for hybrid lexical+vector ranking.

/**
 * A document's identity from a chunk title: the title with the "— part N/M"
 * chunk suffix stripped, lowercased. Lets retrieval tell two chunks of the SAME
 * document apart from two different documents.
 */
export function documentKey(title: string): string {
  return title.replace(/\s*[—-]\s*part\s*\d+\s*\/\s*\d+\s*$/i, '').trim().toLowerCase();
}

/**
 * Pick the top-K items with per-document diversity: at most `perDocCap` chunks
 * from any one document, so a single long guide (dozens of chunks) can't fill
 * every slot and crowd out other relevant documents (a datasheet, a how-to
 * entry, the brand's monitoring-app steps). `items` MUST already be sorted best-
 * first. Falls back to the next-best overflow chunks only if the cap left the
 * result short of K, so we never return fewer than we could.
 */
export function diversify<T>(items: T[], topK: number, perDocCap: number, keyOf: (t: T) => string): T[] {
  const picked: T[] = [];
  const overflow: T[] = [];
  const count = new Map<string, number>();
  for (const it of items) {
    const k = keyOf(it);
    const n = count.get(k) ?? 0;
    if (n < perDocCap) {
      picked.push(it);
      count.set(k, n + 1);
      if (picked.length === topK) return picked;
    } else {
      overflow.push(it);
    }
  }
  for (const it of overflow) {
    if (picked.length >= topK) break;
    picked.push(it);
  }
  return picked.slice(0, topK);
}

const STOP = new Set(
  'the a an and or of to is it in on for what can how do does with this that are your you at from have has any should could will would about which when where who whom'.split(
    ' ',
  ),
);

/**
 * Distinct, meaningful query terms from a question. Keeps ordinary words (len > 2,
 * non-stop) AND short model codes that carry a digit (e.g. "s5", "8k", "g3", "h2")
 * which the length filter would otherwise drop, PLUS whole hyphenated model codes
 * ("s5-gc", "sun-8k", "sg05lp1-au") — the rarest, most discriminating tokens, which
 * is exactly what must survive so a spec question lands on the right datasheet.
 */
export function queryTerms(question: string): string[] {
  const lc = question.toLowerCase();
  const terms = new Set<string>();
  for (const t of lc.match(/[a-z0-9]+/g) || []) {
    if (STOP.has(t)) continue;
    // Keep normal words, and short tokens only when they look like a model code (has a digit).
    if (t.length > 2 || /\d/.test(t)) terms.add(t);
  }
  // Whole hyphenated alphanumeric codes, kept verbatim (matched as a substring later).
  for (const code of lc.match(/[a-z0-9]+(?:-[a-z0-9]+)+/g) || []) terms.add(code);
  return [...terms];
}

/** Fraction of distinct query terms present in the text (0..1). */
export function lexicalScore(text: string, terms: string[]): number {
  if (!terms.length) return 0;
  const hay = text.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return hits / terms.length;
}

/**
 * Document frequency of each query term across the corpus: how many chunk texts
 * contain the term. Caller supplies already-lowercased hay strings for speed.
 */
export function documentFrequencies(terms: string[], hays: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, 0);
  for (const hay of hays) {
    for (const t of terms) if (hay.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return df;
}

/**
 * IDF weight per term: rare terms (a model number like "s5"/"8k") weigh far more
 * than terms in most chunks (generic words like "efficiency"/"inverter"). Smoothed
 * so a term in every chunk still contributes a little. n = corpus size.
 */
export function idfWeights(terms: string[], df: Map<string, number>, n: number): Map<string, number> {
  const w = new Map<string, number>();
  for (const t of terms) w.set(t, Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1);
  return w;
}

/**
 * IDF-weighted keyword overlap (0..1): the fraction of query-term *weight* present
 * in the text. This is what surfaces the datasheet chunk that literally names the
 * model being asked about, instead of a verbose install guide that merely repeats
 * the generic words in the question. Falls back to weight 1 for unknown terms.
 */
export function lexicalScoreIdf(text: string, terms: string[], idf: Map<string, number>): number {
  if (!terms.length) return 0;
  const hay = text.toLowerCase();
  let hit = 0;
  let total = 0;
  for (const t of terms) {
    const w = idf.get(t) ?? 1;
    total += w;
    if (hay.includes(t)) hit += w;
  }
  return total ? hit / total : 0;
}
