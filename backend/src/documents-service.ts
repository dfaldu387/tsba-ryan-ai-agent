import { getStorage } from './storage.js';
import { docChunkPrefix } from './drive-ingest.js';
import { docId as gmailDocId } from './gmail-ingest.js';

// Remove an ingested document and its knowledge chunks, regardless of source.
// Drive chunks are keyed `drive:<fileId>:<n>`; Gmail chunks `gmail:<msgId>:<n>`
// (where the document id is already `gmail:<msgId>`).
export async function removeIngestedDocument(id: string): Promise<boolean> {
  const storage = await getStorage();
  const doc = await storage.documents.get(id);
  const removed = await storage.documents.remove(id);

  const prefix =
    doc?.source === 'gmail' || id.startsWith(gmailDocId(''))
      ? `${id}:` // gmail document id already includes the `gmail:` qualifier
      : docChunkPrefix(id); // drive: `drive:<id>:`
  await storage.knowledge.removeByPrefix(prefix);

  return Boolean(removed);
}
