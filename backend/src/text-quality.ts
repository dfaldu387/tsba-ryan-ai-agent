// Shared text-quality helpers: used at ingest time to decide whether a PDF's
// text layer is usable or the document is really image-based (so we should OCR
// it), and at answer time to pick clean, on-topic sentences instead of raw
// ingested noise (table-of-contents lines, page numbers, CJK blocks, etc.).

/**
 * A sentence/line is junk when it isn't usable English prose: too short (a
 * heading or page number), mostly digits/symbols, heavy non-Latin script (e.g. a
 * Chinese table of contents), a dotted TOC leader, a catalogue heading ending in
 * a page number, or a dense list of model codes.
 */
export function isJunkLine(s: string): boolean {
  const t = s.trim();
  if (t.length < 12) return true;
  const letters = t.replace(/[^a-z]/gi, '').length;
  if (letters < t.length * 0.3) return true;
  const nonAscii = (t.match(/[^\x00-\x7F]/g) || []).length;
  if (nonAscii > t.length * 0.12) return true;
  if (/\.{3,}\s*\d+\s*$/.test(t)) return true;
  if (/^(目录|table of contents|contents|catalogue|catalog)\b/i.test(t)) return true;
  const words = t.split(/\s+/);
  if (words.length <= 6 && /^[A-Za-z][A-Za-z &/'’-]*\s+\d{1,3}$/.test(t)) return true;
  const modelCodes = (t.match(/\b[A-Za-z]+-?\d[\w-]*\b/g) || []).length;
  if (modelCodes >= 4 && letters < t.length * 0.6) return true;
  return false;
}

/** Clean, non-junk sentences/lines from a block of text. */
export function cleanSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0 && !isJunkLine(s));
}

/** How many characters of genuinely usable prose a block of text contains. */
export function usableTextLength(text: string): number {
  return cleanSentences(text).reduce((n, s) => n + s.length, 0);
}

// Below this much usable prose, a document's text layer is treated as unusable —
// almost certainly an image-based PDF whose real content lives inside page images.
const MIN_USABLE_CHARS = 400;

/**
 * True when a PDF's text layer is corrupted by a broken font/glyph mapping — the
 * extractor drops a whole letter (e.g. every "s"), producing text like
 * "Soli Single Pha e ... En ure ... power upply tability".
 *
 * Detected by letter frequency: in English each of the most common letters
 * appears several percent of the time, so if one of them is almost entirely
 * absent, that glyph was dropped. This cleanly separates real corruption
 * (missing letter ~1% share) from clean but short-token-dense datasheets
 * (model codes, bullets, blanks) which keep every common letter above ~3.8%.
 */
export function looksCorrupted(text: string): boolean {
  const letters = text.toLowerCase().match(/[a-z]/g) || [];
  if (letters.length < 200) return false; // too little text to judge reliably
  const freq: Record<string, number> = {};
  for (const ch of letters) freq[ch] = (freq[ch] || 0) + 1;
  const n = letters.length;
  const common = ['e', 't', 'a', 'o', 'n', 's', 'r', 'i'];
  return common.some((ch) => (freq[ch] || 0) / n < 0.02);
}

/**
 * True when a PDF's extracted text is too poor to rely on (empty, mostly junk
 * fragments, or glyph-corrupted) — the signal to OCR it. Catches both image-based
 * datasheets and ones with a broken text-layer font encoding.
 */
export function isLowQualityExtract(text: string): boolean {
  const usable = usableTextLength(text);
  if (usable < MIN_USABLE_CHARS) return true;
  if (looksCorrupted(text)) return true;
  // Mostly noise even if long (e.g. a scanned catalogue with stray text).
  const raw = text.replace(/\s+/g, ' ').trim().length;
  return raw > 0 && usable / raw < 0.4;
}

/**
 * A comparable quality score for choosing between the raw text layer and OCR:
 * usable prose length, heavily penalised when the text is glyph-corrupted. This
 * makes OCR win over a long-but-garbled text layer even when both are similar
 * length.
 */
export function extractionScore(text: string): number {
  return usableTextLength(text) * (looksCorrupted(text) ? 0.3 : 1);
}
