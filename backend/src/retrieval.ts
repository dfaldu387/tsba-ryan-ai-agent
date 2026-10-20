import type { KnowledgeEntry } from '@tsba/shared';
import { query, toVectorLiteral } from './db.js';
import { embeddingProvider } from './embeddings.js';

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

const COLS = 'id, kind, brand, model, topic, title, body, source, confidence';

/**
 * Retrieval strategy:
 *  - ALL verified rules are always included (small set, compliance-critical — we
 *    never want RAG to drop a safety rule).
 *  - Manufacturer answers: top-K by pgvector cosine distance to the question.
 *  - If embeddings aren't populated yet, fall back to a keyword match so the
 *    pipeline still returns something useful.
 */
export async function retrieve(question: string, topK: number): Promise<KnowledgeEntry[]> {
  const rules = await query<Row>(`SELECT ${COLS} FROM knowledge_entries WHERE kind = 'rule' ORDER BY id`);

  let makers: Row[] = [];
  let usedVectorSearch = false;

  try {
    const [qvec] = await embeddingProvider.embed([question]);
    const res = await query<Row>(
      `SELECT ${COLS}
         FROM knowledge_entries
        WHERE kind = 'maker' AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2`,
      [toVectorLiteral(qvec), topK],
    );
    makers = res.rows;
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
      makers = res.rows;
    }
  }

  return [...rules.rows.map(rowToEntry), ...makers.map(rowToEntry)];
}
