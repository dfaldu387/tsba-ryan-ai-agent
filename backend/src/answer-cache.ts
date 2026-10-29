import { embeddingProvider } from './embeddings.js';

// ─── Semantic answer cache ───────────────────────────────────────────────────
// Returns a previously-generated answer when the same question is asked again —
// even worded differently ("how many DEYE inverter types" ≈ "list DEYE
// inverters") — so we skip the LLM call entirely (saving tokens and latency).
//
// Matching: with a real (semantic) embedding provider we match on cosine
// similarity of the question embeddings. Local embeddings are non-semantic
// (their cosine is noise), so there we SAFELY fall back to exact-normalized
// matching — a wrong paraphrase hit would return a wrong answer, which we never
// risk. Enable semantic matching by setting EMBEDDING_PROVIDER=voyage|openai.
//
// Entries are partitioned (by audience, or audience|channel) so a customer and
// an installer never share an answer, expire after a TTL, and the whole cache is
// cleared whenever the knowledge base changes so answers never go stale.

const SEMANTIC = embeddingProvider.name !== 'local';
const ENABLED = (process.env.ANSWER_CACHE ?? 'on').toLowerCase() !== 'off';
// Cosine ≥ this counts as the same question (semantic mode only). High on
// purpose: better to miss and regenerate than to return a wrong answer.
const THRESHOLD = Number(process.env.ANSWER_CACHE_THRESHOLD ?? '0.93');
const TTL_MS = Number(process.env.ANSWER_CACHE_TTL_MS ?? String(24 * 60 * 60 * 1000));
const MAX_PER_BUCKET = 200;

interface Entry {
  vec: number[]; // question embedding (empty in local/exact mode)
  norm: string; // normalized question text (exact-match key)
  value: unknown;
  at: number; // last touched (for TTL + LRU)
}

const buckets = new Map<string, Entry[]>();

function normalize(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Vectors from the provider are L2-normalized, so a dot product IS the cosine.
function dot(a: number[], b: number[]): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
}

async function embedQuestion(q: string): Promise<number[]> {
  const [v] = await embeddingProvider.embed([q]);
  return v;
}

/**
 * Whether a question is self-contained enough to cache. Short or context-
 * dependent follow-ups ("what about warranty?", "and the price?") depend on the
 * conversation, so we never cache or serve them — they always go to the model.
 */
export function isStandaloneQuestion(q: string): boolean {
  const n = q.trim().toLowerCase();
  if (!n) return false;
  const followups = [
    'what about', 'how about', 'what else', 'and ', 'also ', 'is it', 'does it',
    'can it', 'will it', 'that ', 'those ', 'this ', 'they ', 'it ', 'why not',
  ];
  if (followups.some((p) => n.startsWith(p))) return false;
  const tokens = (n.match(/[a-z0-9.]+/g) ?? []).filter((t) => t.length > 2);
  return tokens.length >= 3; // too few content words to match safely
}

function liveBucket(key: string): Entry[] {
  const bucket = buckets.get(key);
  if (!bucket) return [];
  const now = Date.now();
  const live = bucket.filter((e) => now - e.at < TTL_MS);
  if (live.length !== bucket.length) buckets.set(key, live);
  return live;
}

/** Look up a cached value for this question in the given namespace+partition. */
export async function cacheLookup<T>(
  namespace: string,
  partition: string,
  question: string,
): Promise<T | null> {
  if (!ENABLED) return null;
  const live = liveBucket(`${namespace}|${partition}`);
  if (!live.length) return null;

  if (SEMANTIC) {
    const qv = await embedQuestion(question);
    let best: Entry | null = null;
    let bestSim = -1;
    for (const e of live) {
      const s = dot(qv, e.vec);
      if (s > bestSim) {
        bestSim = s;
        best = e;
      }
    }
    if (best && bestSim >= THRESHOLD) {
      best.at = Date.now();
      return best.value as T;
    }
    return null;
  }

  // Local/exact mode: only a normalized-identical question reuses an answer.
  const norm = normalize(question);
  const hit = live.find((e) => e.norm === norm);
  if (hit) {
    hit.at = Date.now();
    return hit.value as T;
  }
  return null;
}

/** Store a generated value for this question. */
export async function cacheStore<T>(
  namespace: string,
  partition: string,
  question: string,
  value: T,
): Promise<void> {
  if (!ENABLED) return;
  const key = `${namespace}|${partition}`;
  const entry: Entry = {
    vec: SEMANTIC ? await embedQuestion(question) : [],
    norm: normalize(question),
    value,
    at: Date.now(),
  };
  let bucket = buckets.get(key);
  if (!bucket) buckets.set(key, (bucket = []));
  const dupe = bucket.findIndex((e) => e.norm === entry.norm);
  if (dupe >= 0) bucket[dupe] = entry;
  else bucket.push(entry);
  if (bucket.length > MAX_PER_BUCKET) bucket.splice(0, bucket.length - MAX_PER_BUCKET);
}

/** Drop all cached answers — called whenever the knowledge base changes. */
export function invalidateAnswerCache(): void {
  buckets.clear();
}

/** True when semantic (paraphrase) matching is active; false means exact-only. */
export function answerCacheIsSemantic(): boolean {
  return SEMANTIC && ENABLED;
}
