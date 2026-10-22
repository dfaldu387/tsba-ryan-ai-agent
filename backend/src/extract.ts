import mammoth from 'mammoth';
// Import the library file directly to skip pdf-parse's index.js debug harness
// (which reads a bundled test PDF when run as a main module).
// @ts-expect-error — no types for the deep import; shape declared below.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

type PdfParse = (data: Buffer) => Promise<{ text: string }>;
const parsePdf = pdfParse as unknown as PdfParse;

/** Collapse whitespace runs and trim, keeping paragraph breaks. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Extract plain text from a file's bytes by content type. Returns '' when the
 * type is unsupported or yields no text, so the caller can mark it 'skipped'.
 */
export async function extractText(buffer: Buffer, contentType: string): Promise<string> {
  const ct = contentType.split(';')[0].trim().toLowerCase();

  if (ct === 'application/pdf') {
    const out = await parsePdf(buffer);
    return tidy(out.text ?? '');
  }

  if (ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const out = await mammoth.extractRawText({ buffer });
    return tidy(out.value ?? '');
  }

  if (ct === 'text/html') return tidy(stripHtml(buffer.toString('utf8')));

  if (
    ct === 'text/plain' ||
    ct === 'text/markdown' ||
    ct === 'text/csv' ||
    ct === 'application/json'
  ) {
    return tidy(buffer.toString('utf8'));
  }

  return '';
}

/** Break an oversized paragraph into <=maxChars pieces, on sentences then length. */
function splitLong(para: string, maxChars: number): string[] {
  const out: string[] = [];
  const sentences = para.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [para];
  let sub = '';
  const push = () => {
    if (sub.trim()) out.push(sub.trim());
    sub = '';
  };
  for (let sentence of sentences) {
    // A single sentence longer than the window: hard-slice by length.
    while (sentence.length > maxChars) {
      push();
      out.push(sentence.slice(0, maxChars).trim());
      sentence = sentence.slice(maxChars);
    }
    if ((sub + ' ' + sentence).trim().length > maxChars) {
      push();
      sub = sentence;
    } else {
      sub = (sub + ' ' + sentence).trim();
    }
  }
  push();
  return out;
}

/**
 * Split text into chunks on paragraph boundaries, targeting ~maxChars each, with
 * a little trailing overlap so retrieval doesn't split context across a boundary.
 */
export function chunkText(text: string, maxChars = 1200, overlap = 150): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const paras = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = '';

  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = '';
  };

  for (const para of paras) {
    if (para.length > maxChars) {
      flush();
      chunks.push(...splitLong(para, maxChars));
      continue;
    }
    if ((buf + '\n\n' + para).trim().length > maxChars) {
      flush();
      buf = para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  flush();

  // Prepend a small tail of the previous chunk to each chunk for continuity.
  if (overlap > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const tail = prev.slice(Math.max(0, prev.length - overlap));
      chunks[i] = `${tail}\n\n${chunks[i]}`;
    }
  }
  return chunks;
}
