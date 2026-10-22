import type { IngestStatus, IngestedDocument, TextQuality } from '@tsba/shared';
import { query } from './db.js';

interface DocRow {
  id: string;
  source: string;
  title: string;
  mime_type: string;
  web_url: string | null;
  chunk_count: number;
  byte_size: string | number | null;
  status: IngestStatus;
  text_quality: TextQuality | null;
  ingested_at: Date;
}

const SELECT = 'id, source, title, mime_type, web_url, chunk_count, byte_size, status, text_quality, ingested_at';

function toDoc(r: DocRow): IngestedDocument {
  return {
    id: r.id,
    source: r.source as 'google-drive',
    title: r.title,
    mime_type: r.mime_type,
    web_url: r.web_url,
    chunk_count: Number(r.chunk_count),
    byte_size: r.byte_size != null ? Number(r.byte_size) : null,
    status: r.status,
    text_quality: r.text_quality ?? undefined,
    ingested_at: r.ingested_at.toISOString(),
  };
}

export async function listDocuments(): Promise<IngestedDocument[]> {
  const res = await query<DocRow>(`SELECT ${SELECT} FROM documents ORDER BY ingested_at DESC`);
  return res.rows.map(toDoc);
}

export async function getDocument(id: string): Promise<IngestedDocument | null> {
  const res = await query<DocRow>(`SELECT ${SELECT} FROM documents WHERE id = $1`, [id]);
  return res.rows[0] ? toDoc(res.rows[0]) : null;
}

export async function upsertDocument(doc: IngestedDocument): Promise<IngestedDocument> {
  const res = await query<DocRow>(
    `INSERT INTO documents (id, source, title, mime_type, web_url, chunk_count, byte_size, status, text_quality, ingested_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET
       source=EXCLUDED.source, title=EXCLUDED.title, mime_type=EXCLUDED.mime_type, web_url=EXCLUDED.web_url,
       chunk_count=EXCLUDED.chunk_count, byte_size=EXCLUDED.byte_size, status=EXCLUDED.status,
       text_quality=EXCLUDED.text_quality, ingested_at=EXCLUDED.ingested_at
     RETURNING ${SELECT}`,
    [
      doc.id,
      doc.source,
      doc.title,
      doc.mime_type,
      doc.web_url,
      doc.chunk_count,
      doc.byte_size,
      doc.status,
      doc.text_quality ?? null,
      doc.ingested_at,
    ],
  );
  return toDoc(res.rows[0]);
}

export async function removeDocument(id: string): Promise<IngestedDocument | null> {
  const res = await query<DocRow>(`DELETE FROM documents WHERE id = $1 RETURNING ${SELECT}`, [id]);
  return res.rows[0] ? toDoc(res.rows[0]) : null;
}
