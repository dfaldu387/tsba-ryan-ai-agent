// Brand detection for step 3 of the support flow ("identify the inverter brand"
// before retrieving the matching source). Brands mirror the `brand` field stored
// on knowledge entries: the supported manufacturers plus "All" for brand-agnostic
// rules. Detection is deliberately conservative — token matches only, so short
// names like "SAJ" don't fire on substrings of unrelated words.

/** Canonical brand name, as stored on knowledge entries, e.g. 'Deye' | 'Solis'. */
export type Brand = string;

/** Brand-agnostic entries (compliance rules, general guidance) use this value. */
export const ALL_BRANDS = 'All';

// Canonical brand -> the aliases/spellings a person (or a filename) might use.
// Add a brand here and it flows through detection, brand-aware ranking AND the
// ingest-time tagging of Drive documents automatically — one place to maintain.
const BRAND_ALIASES: Record<string, string[]> = {
  Deye: ['deye'],
  SAJ: ['saj'],
  SOFAR: ['sofar', 'sofarsolar', 'sofar solar'],
  Solis: ['solis', 'ginlong'],
  Sungrow: ['sungrow'],
  Fronius: ['fronius'],
  GoodWe: ['goodwe'],
  Growatt: ['growatt'],
  Tesla: ['tesla', 'powerwall'],
};

/** The brands the agent knows about (canonical names). */
export const KNOWN_BRANDS: string[] = Object.keys(BRAND_ALIASES);

// Pre-build a matcher per brand: a regex that matches any alias as a whole token.
const BRAND_MATCHERS: Array<{ brand: string; re: RegExp }> = (
  Object.entries(BRAND_ALIASES) as Array<[string, string[]]>
).map(([brand, aliases]) => ({
  brand,
  // \b around each alias so "saj" matches "my SAJ inverter" but not "sajjad".
  re: new RegExp(`\\b(?:${aliases.map(escapeRegExp).join('|')})\\b`, 'i'),
}));

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect a single inverter brand mentioned in free text. Returns the canonical
 * brand, or null when none (or more than one) is clearly present — in the
 * ambiguous case we prefer to fall back to brand-agnostic retrieval rather than
 * guess the wrong brand.
 */
export function detectBrand(text: string): Brand | null {
  if (!text) return null;
  const found = BRAND_MATCHERS.filter(({ re }) => re.test(text)).map((m) => m.brand);
  const unique = [...new Set(found)];
  return unique.length === 1 ? unique[0] : null;
}

/**
 * Detect the brand from a conversation, scanning most-recent messages first so a
 * brand named earlier in a voice call still counts, while a later correction wins.
 */
export function detectBrandFromTurns(contents: string[]): Brand | null {
  for (let i = contents.length - 1; i >= 0; i--) {
    const brand = detectBrand(contents[i]);
    if (brand) return brand;
  }
  return null;
}

/**
 * True when a knowledge entry should be preferred for the detected brand: it's
 * that brand, or brand-agnostic. Single source of truth for brand-aware ranking.
 */
export function brandMatches(entryBrand: string, brand: Brand | string | null | undefined): boolean {
  if (!brand) return false;
  return entryBrand === brand || entryBrand === ALL_BRANDS;
}
