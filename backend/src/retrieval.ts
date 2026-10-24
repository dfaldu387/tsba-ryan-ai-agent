import type { KnowledgeEntry } from '@tsba/shared';
import { query } from './db.js';
import { embeddingProvider } from './embeddings.js';
import { brandMatches } from './brand.js';
import { documentFrequencies, idfWeights, lexicalScoreIdf, queryTerms } from './retrieval-util.js';

// Added to a maker entry's score when its brand matches the brand detected for the
// question (or it's brand-agnostic). Big enough to float a same-brand source above
// a slightly-better wrong-brand one, small enough not to rescue an irrelevant one.
const BRAND_BONUS = 0.15;

// The 'local' embedding provider is a hashed bag-of-words, NOT a semantic model —
// its cosine is effectively noise (an unrelated doc can score higher than the exact
// datasheet). So when embeddings are local we rank on the IDF keyword signal and keep
// cosine only as a faint tiebreaker. With a real provider the semantic cosine leads
// and the keyword overlap just nudges exact model/spec matches up.
const LOCAL_EMBEDDINGS = embeddingProvider.name === 'local';
const LEXICAL_WEIGHT = LOCAL_EMBEDDINGS ? 1.0 : 0.6;
const COSINE_WEIGHT = LOCAL_EMBEDDINGS ? 0.05 : 1.0;

interface Row {
  id: string;
  kind: 'rule' | 'maker';
  brand: string;
  model: string;
  topic: string;
  title: string;
  body: string;
  source: string;
  confidence: string | null;
}

interface MakerRow extends Row {
  embedding: number[] | null;
}

function rowToEntry(r: Row): KnowledgeEntry {
  return {
    id: r.id,
    kind: r.kind,
    brand: r.brand,
    model: r.model,
    topic: r.topic,
    title: r.title,
    text: r.body,
    source: r.source,
    confidence: (r.confidence as KnowledgeEntry['confidence']) ?? undefined,
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const COLS = 'id, kind, brand, model, topic, title, body, source, confidence';

/**
 * Retrieval strategy (no pgvector — cosine is computed in Node):
 *  - ALL verified rules are always included (small set, compliance-critical — we
 *    never want RAG to drop a safety rule).
 *  - Manufacturer answers: fetch those with an embedding, rank by cosine to the
 *    question vector, take top-K.
 *  - If no embeddings are populated yet (or embedding fails), fall back to a
 *    keyword match so the pipeline still returns something useful.
 */
export async function retrieve(
  question: string,
  topK: number,
  brand?: string | null,
): Promise<KnowledgeEntry[]> {
  const rules = await query<Row>(`SELECT ${COLS} FROM knowledge_entries WHERE kind = 'rule' ORDER BY id`);

  let makers: Row[] = [];
  let usedVectorSearch = false;
  const terms = queryTerms(question);

  try {
    const [qvec] = await embeddingProvider.embed([question]);
    // real[] comes back from node-pg already parsed into a number[].
    const res = await query<MakerRow>(
      `SELECT ${COLS}, embedding
         FROM knowledge_entries
        WHERE kind = 'maker' AND embedding IS NOT NULL`,
    );
    // Precompute each chunk's search text once, then derive IDF weights so the
    // rare discriminating token (the model number) dominates the keyword score.
    const hays = res.rows.map((r) => `${r.title} ${r.body}`.toLowerCase());
    const idf = idfWeights(terms, documentFrequencies(terms, hays), res.rows.length);
    makers = res.rows
      .map((r, i) => ({
        r,
        // Hybrid: semantic (cosine) + IDF-weighted keyword overlap + brand boost.
        score:
          COSINE_WEIGHT * cosine(qvec, r.embedding ?? []) +
          LEXICAL_WEIGHT * lexicalScoreIdf(hays[i], terms, idf) +
          (brandMatches(r.brand, brand) ? BRAND_BONUS : 0),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((x) => x.r);
    usedVectorSearch = makers.length > 0;
  } catch (err) {
    console.warn('[retrieval] vector search failed, falling back to keyword:', (err as Error).message);
  }

  if (!usedVectorSearch) {
    const terms = (question.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 2).slice(0, 12);
    if (terms.length) {
      const likeClauses = terms.map((_, i) => `(lower(title) LIKE $${i + 1} OR lower(body) LIKE $${i + 1} OR lower(brand) LIKE $${i + 1})`);
      const res = await query<Row>(
        `SELECT ${COLS} FROM knowledge_entries
          WHERE kind = 'maker' AND (${likeClauses.join(' OR ')})
          LIMIT $${terms.length + 1}`,
        [...terms.map((t) => `%${t}%`), topK],
      );
      // Brand-aware: surface matching-brand rows first in the keyword fallback.
      makers = brand
        ? res.rows.slice().sort((a, b) => Number(brandMatches(b.brand, brand)) - Number(brandMatches(a.brand, brand)))
        : res.rows;
    }
  }

  return [...rules.rows.map(rowToEntry), ...makers.map(rowToEntry)];
}
