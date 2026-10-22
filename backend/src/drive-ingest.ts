import type {
  DriveFolderSource,
  FolderSyncResult,
  IngestResult,
  IngestedDocument,
  KnowledgeEntry,
} from '@tsba/shared';
import {
  collectFiles,
  DriveAuthError,
  fetchFileBytes,
  getFileMeta,
  isIngestable,
  ocrPdfToText,
} from './google-drive.js';
import { extractText, chunkText } from './extract.js';
import { detectBrand } from './brand.js';
import { extractionScore, isLowQualityExtract, looksCorrupted } from './text-quality.js';
import { anthropicConfigured, extractPdfWithClaude } from './anthropic.js';
import { driveHasWriteScope } from './connections.js';
import type { TextQuality } from '@tsba/shared';

// Claude's PDF document input is limited to 32MB / 100 pages; skip the vision
// pass above this and fall back to Drive OCR.
const CLAUDE_PDF_MAX_BYTES = 32 * 1024 * 1024;
import { getStorage } from './storage.js';

// Orchestrates one file: Drive → text → chunks → knowledge entries + a document
// record. Chunks are stored as 'maker' knowledge with ids `drive:<fileId>:<n>`
// so removing the document can delete them all by prefix.

const MAX_CHUNKS = 400; // safety cap for a very large document

export function docChunkPrefix(fileId: string): string {
  return `drive:${fileId}:`;
}

// Neutral brand for ingested chunks we can't attribute to a manufacturer. NOT
// 'All' (which brand-aware retrieval treats as matching every brand) — so an
// unattributed doc is never wrongly boosted for a specific brand question.
const UNATTRIBUTED_BRAND = 'TSBA Drive';

function buildEntries(
  fileId: string,
  name: string,
  webUrl: string | null,
  chunks: string[],
): KnowledgeEntry[] {
  const total = chunks.length;
  const sourceBase = webUrl ? `${name} — Google Drive (${webUrl})` : `${name} — Google Drive`;

  // Attribute the document to a brand so brand-aware retrieval can find it: the
  // filename is the strongest signal, with the opening text as a fallback. Each
  // chunk may override with a brand it names itself (handles multi-brand catalogues).
  const docBrand = detectBrand(name) ?? detectBrand(chunks.slice(0, 3).join(' '));

  return chunks.map((text, i) => ({
    id: `${docChunkPrefix(fileId)}${i}`,
    kind: 'maker',
    brand: detectBrand(text) ?? docBrand ?? UNATTRIBUTED_BRAND,
    model: '',
    topic: name.slice(0, 120),
    title: total > 1 ? `${name} — part ${i + 1}/${total}` : name,
    text,
    source: sourceBase,
    confidence: 'medium',
  }));
}

/** Ingest a single Drive file. Records a document row (including skips/failures). */
export async function ingestFile(fileId: string): Promise<IngestResult> {
  const storage = await getStorage();

  let name = fileId;
  try {
    const meta = await getFileMeta(fileId);
    name = meta.name;

    const recordDoc = (
      status: IngestedDocument['status'],
      chunkCount: number,
      textQuality?: TextQuality,
    ): Promise<IngestedDocument> =>
      storage.documents.upsert({
        id: fileId,
        source: 'google-drive',
        title: meta.name,
        mime_type: meta.mimeType,
        web_url: meta.webViewLink,
        chunk_count: chunkCount,
        byte_size: meta.size,
        status,
        text_quality: textQuality,
        ingested_at: new Date().toISOString(),
      });

    if (meta.mimeType && !isIngestable(meta.mimeType)) {
      await recordDoc('skipped', 0);
      return { fileId, name, status: 'skipped', chunks: 0, reason: `unsupported type: ${meta.mimeType}` };
    }

    const { buffer, contentType } = await fetchFileBytes(fileId, meta.mimeType);
    const rawText = await extractText(buffer, contentType);

    // For a PDF whose text layer is empty, image-based, or glyph-corrupted, try
    // to re-extract and keep whichever method yields the best (most usable,
    // uncorrupted) text:
    //   1. Claude native PDF — reads the pages as images, so it handles scanned
    //      / image-only PDFs and broken font encodings. Primary.
    //   2. Google Drive OCR — fallback when Claude isn't available or errors.
    // This is what stops large scanned datasheets/guides being skipped.
    let bestText = rawText;
    if (meta.mimeType === 'application/pdf' && isLowQualityExtract(rawText)) {
      const consider = (candidate: string) => {
        if (extractionScore(candidate) > extractionScore(bestText)) bestText = candidate;
      };

      if (anthropicConfigured() && (meta.size ?? 0) <= CLAUDE_PDF_MAX_BYTES) {
        try {
          consider(await extractPdfWithClaude(buffer));
        } catch (err) {
          console.warn(`[ingest] Claude PDF extraction failed for ${meta.name}:`, (err as Error).message);
        }
      }
      // Drive OCR fallback — only when the text is still poor AND Drive is
      // connected with write scope (the OCR copies a file into a temp Doc).
      // Read-only connections skip it silently; Claude already did extraction.
      if (isLowQualityExtract(bestText) && (await driveHasWriteScope())) {
        try {
          consider(await ocrPdfToText(fileId, meta.name));
        } catch (err) {
          console.warn(`[ingest] Drive OCR fallback skipped for ${meta.name}: ${(err as Error).message.slice(0, 160)}`);
        }
      }
    }

    const chunks = chunkText(bestText).slice(0, MAX_CHUNKS);

    if (!chunks.length) {
      await recordDoc('skipped', 0);
      return { fileId, name, status: 'skipped', chunks: 0, reason: 'no extractable text (even after Claude + OCR)' };
    }

    // Replace any prior chunks for this file, then add the fresh set.
    await storage.knowledge.removeByPrefix(docChunkPrefix(fileId));
    await storage.knowledge.add(buildEntries(fileId, meta.name, meta.webViewLink, chunks));

    // Record how usable the stored text is, so the admin can see (and re-ingest)
    // documents whose text is corrupted or too thin to answer from.
    const joined = chunks.join('\n');
    const quality: TextQuality = looksCorrupted(joined) ? 'corrupted' : isLowQualityExtract(joined) ? 'low' : 'ok';
    await recordDoc('ingested', chunks.length, quality);

    return { fileId, name, status: 'ingested', chunks: chunks.length };
  } catch (err) {
    return { fileId, name, status: 'failed', chunks: 0, reason: (err as Error).message };
  }
}

/** Ingest several files sequentially (keeps embedding/LLM load predictable). */
export async function ingestFiles(fileIds: string[]): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const id of fileIds) results.push(await ingestFile(id));
  return results;
}

/** Remove an ingested document and all of its knowledge chunks. */
export async function removeDocument(fileId: string): Promise<boolean> {
  const storage = await getStorage();
  const removed = await storage.documents.remove(fileId);
  await storage.knowledge.removeByPrefix(docChunkPrefix(fileId));
  return Boolean(removed);
}

// ─── Folder sources ──────────────────────────────────────────────────────────

/** Ingest every supported file in a folder and update the source's sync state. */
export async function syncFolder(folder: DriveFolderSource): Promise<FolderSyncResult> {
  const storage = await getStorage();
  const files = await collectFiles(folder.id, folder.recursive);
  const results = await ingestFiles(files.map((f) => f.id));

  await storage.folders.upsert({
    ...folder,
    last_synced_at: new Date().toISOString(),
    last_file_count: files.length,
  });

  return {
    folderId: folder.id,
    name: folder.name,
    filesFound: files.length,
    ingested: results.filter((r) => r.status === 'ingested').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  };
}

/** Register a folder as a knowledge source and ingest its contents immediately. */
export async function addFolderSource(
  folderId: string,
  recursive: boolean,
): Promise<FolderSyncResult> {
  const storage = await getStorage();
  const meta = await getFileMeta(folderId);
  const existing = await storage.folders.get(folderId);

  const folder: DriveFolderSource = {
    id: folderId,
    name: meta.name,
    web_url: meta.webViewLink,
    recursive,
    added_at: existing?.added_at ?? new Date().toISOString(),
    last_synced_at: null,
    last_file_count: null,
  };
  await storage.folders.upsert(folder);
  return syncFolder(folder);
}

/** Add several folders as knowledge sources in one go (each ingested). */
export async function addFolderSources(
  folderIds: string[],
  recursive: boolean,
): Promise<FolderSyncResult[]> {
  const out: FolderSyncResult[] = [];
  for (const id of folderIds) {
    try {
      out.push(await addFolderSource(id, recursive));
    } catch (err) {
      // One bad/inaccessible folder shouldn't sink the batch — record and continue.
      const reason = err instanceof DriveAuthError ? 'Drive access error (reconnect Google Drive)' : (err as Error).message;
      out.push({ folderId: id, name: id, filesFound: 0, ingested: 0, skipped: 0, failed: 1, results: [], error: reason });
    }
  }
  return out;
}

/** Re-ingest a previously selected folder by id. Returns null if not selected. */
export async function syncFolderById(folderId: string): Promise<FolderSyncResult | null> {
  const storage = await getStorage();
  const folder = await storage.folders.get(folderId);
  if (!folder) return null;
  return syncFolder(folder);
}

/**
 * Re-ingest every selected folder source. Resilient: a failure on one folder —
 * including a Drive access error (expired token, lost permission on that folder)
 * — is recorded on that folder's result and the rest still run, instead of
 * aborting the whole batch and leaving later folders un-synced.
 */
export async function syncAllFolders(): Promise<FolderSyncResult[]> {
  const storage = await getStorage();
  const folders = await storage.folders.list();
  const out: FolderSyncResult[] = [];
  for (const f of folders) {
    try {
      out.push(await syncFolder(f));
    } catch (err) {
      const reason = err instanceof DriveAuthError ? 'Drive access error (reconnect Google Drive)' : (err as Error).message;
      out.push({ folderId: f.id, name: f.name, filesFound: 0, ingested: 0, skipped: 0, failed: 1, results: [], error: reason });
    }
  }
  return out;
}

/**
 * Remove a folder source. With `purge`, also deletes the documents (and their
 * knowledge chunks) that were ingested from files in that folder.
 */
export async function removeFolderSource(folderId: string, purge: boolean): Promise<boolean> {
  const storage = await getStorage();
  const removed = await storage.folders.remove(folderId);
  if (!removed) return false;

  if (purge) {
    // Re-walk the folder to find which documents came from it, then drop them.
    try {
      const files = await collectFiles(folderId, removed.recursive);
      for (const f of files) await removeDocument(f.id);
    } catch {
      // Folder may be gone/inaccessible — the source record is removed regardless.
    }
  }
  return true;
}
