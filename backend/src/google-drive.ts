import { DRIVE_FOLDER_MIME, type DriveFile, type DriveListing } from '@tsba/shared';
import { getAccessToken } from './connections.js';

// ─── Google Drive API v3 client (list + fetch content) ───────────────────────
// Uses the stored google-drive OAuth token. Read-only: only files.list,
// files.get?alt=media and files.export are ever called.

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

/** Google-native types we can export to text, and the export MIME to request. */
const GOOGLE_EXPORT: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/** Binary/text types we can extract directly after download. */
const DOWNLOADABLE = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
]);

export function isIngestable(mimeType: string): boolean {
  return mimeType in GOOGLE_EXPORT || DOWNLOADABLE.has(mimeType);
}

class DriveAuthError extends Error {}

async function token(): Promise<string> {
  const t = await getAccessToken('google-drive');
  if (!t) throw new DriveAuthError('google-drive is not connected');
  return t;
}

export { DriveAuthError };

function toDriveFile(f: Record<string, unknown>): DriveFile {
  const mimeType = String(f.mimeType ?? '');
  const isFolder = mimeType === DRIVE_FOLDER_MIME;
  return {
    id: String(f.id ?? ''),
    name: String(f.name ?? '(untitled)'),
    mimeType,
    isFolder,
    ingestable: !isFolder && isIngestable(mimeType),
    webViewLink: f.webViewLink ? String(f.webViewLink) : null,
    modifiedTime: f.modifiedTime ? String(f.modifiedTime) : null,
    size: f.size != null ? Number(f.size) : null,
  };
}

/** List the children of a folder ('root' for the top level), folders first. */
export async function listFolder(
  folderId: string,
  pageToken?: string,
): Promise<DriveListing> {
  const q = `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`;
  const params = new URLSearchParams({
    q,
    fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, webViewLink)',
    pageSize: '100',
    orderBy: 'folder, name_natural',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    spaces: 'drive',
  });
  if (pageToken) params.set('pageToken', pageToken);

  const res = await fetch(`${DRIVE_API}/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${await token()}` },
  });
  if (!res.ok) throw new Error(`Drive list failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { files?: Record<string, unknown>[]; nextPageToken?: string };
  return {
    folderId,
    files: (data.files ?? []).map(toDriveFile),
    nextPageToken: data.nextPageToken ?? null,
  };
}

/**
 * Search the whole Drive by name (folders + files). Uses corpora=allDrives so
 * results include My Drive, "Shared with me" items, AND Shared Drives. (orderBy
 * isn't allowed with allDrives, so we sort client-side: folders first, by name.)
 */
export async function searchFiles(q: string): Promise<DriveFile[]> {
  const safe = q.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `name contains '${safe}' and trashed = false`,
    fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink)',
    pageSize: '100',
    corpora: 'allDrives',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const res = await fetch(`${DRIVE_API}/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${await token()}` },
  });
  if (!res.ok) throw new Error(`Drive search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { files?: Record<string, unknown>[] };
  return (data.files ?? [])
    .map(toDriveFile)
    .sort((a, b) =>
      a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1,
    );
}

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string | null;
  size: number | null;
}

export async function getFileMeta(fileId: string): Promise<DriveFileMeta> {
  const params = new URLSearchParams({
    fields: 'id, name, mimeType, size, webViewLink',
    supportsAllDrives: 'true',
  });
  const res = await fetch(`${DRIVE_API}/files/${fileId}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${await token()}` },
  });
  if (!res.ok) throw new Error(`Drive metadata failed: ${res.status} ${await res.text()}`);
  const f = (await res.json()) as Record<string, unknown>;
  return {
    id: String(f.id),
    name: String(f.name ?? '(untitled)'),
    mimeType: String(f.mimeType ?? ''),
    webViewLink: f.webViewLink ? String(f.webViewLink) : null,
    size: f.size != null ? Number(f.size) : null,
  };
}

const MAX_COLLECT_FILES = 500;
const MAX_DEPTH = 10;

/**
 * Walk a folder and return its ingestable files. With `recursive`, descends into
 * subfolders (depth- and count-capped). Folders themselves are not returned.
 */
export async function collectFiles(folderId: string, recursive: boolean): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  const queue: { id: string; depth: number }[] = [{ id: folderId, depth: 0 }];
  const seen = new Set<string>();

  while (queue.length && out.length < MAX_COLLECT_FILES) {
    const { id, depth } = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);

    let pageToken: string | undefined;
    do {
      const page = await listFolder(id, pageToken);
      for (const f of page.files) {
        if (f.isFolder) {
          if (recursive && depth < MAX_DEPTH) queue.push({ id: f.id, depth: depth + 1 });
        } else if (f.ingestable && out.length < MAX_COLLECT_FILES) {
          out.push(f);
        }
      }
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken && out.length < MAX_COLLECT_FILES);
  }
  return out;
}

/**
 * OCR an image-only PDF via Google Drive: copy it into a Google Doc with OCR
 * enabled, export that doc as plain text, then delete the temporary doc.
 * Needs the full `drive` scope (write). Returns the recognised text.
 */
export async function ocrPdfToText(fileId: string, name: string): Promise<string> {
  const bearer = await token();

  // 1) Copy the PDF into a Google Doc — `ocrLanguage` triggers OCR on the images.
  const copyRes = await fetch(
    `${DRIVE_API}/files/${fileId}/copy?ocrLanguage=en&supportsAllDrives=true`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `[OCR temp] ${name}`, mimeType: 'application/vnd.google-apps.document' }),
    },
  );
  if (!copyRes.ok) throw new Error(`Drive OCR copy failed: ${copyRes.status} ${await copyRes.text()}`);
  const copy = (await copyRes.json()) as { id: string };

  try {
    // 2) Export the OCR'd Google Doc as plain text.
    const exp = await fetch(
      `${DRIVE_API}/files/${copy.id}/export?mimeType=${encodeURIComponent('text/plain')}`,
      { headers: { Authorization: `Bearer ${bearer}` } },
    );
    if (!exp.ok) throw new Error(`Drive OCR export failed: ${exp.status} ${await exp.text()}`);
    return await exp.text();
  } finally {
    // 3) Always clean up the temporary doc.
    await fetch(`${DRIVE_API}/files/${copy.id}?supportsAllDrives=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bearer}` },
    }).catch(() => {});
  }
}

/** Raw bytes of a file: exported text for Google-native types, media otherwise. */
export async function fetchFileBytes(
  fileId: string,
  mimeType: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const bearer = await token();
  const exportMime = GOOGLE_EXPORT[mimeType];
  const url = exportMime
    ? `${DRIVE_API}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`
    : `${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
  if (!res.ok) throw new Error(`Drive download failed: ${res.status} ${await res.text()}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: exportMime ?? mimeType };
}
