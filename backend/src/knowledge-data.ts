import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { KnowledgeEntry } from '@tsba/shared';

// Single source of truth for loading the knowledge JSON from disk.
// Used by the in-memory store and by the Postgres ingest script.

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../../data');
const FILES = [
  'tsba-knowledge-v0.1.json',
  'tsba-knowledge-offline-flow.json',
  'tsba-knowledge-monitoring-apps.json',
];

export function loadKnowledgeEntries(): KnowledgeEntry[] {
  const all: KnowledgeEntry[] = [];
  for (const f of FILES) {
    const raw = JSON.parse(readFileSync(resolve(dataDir, f), 'utf8')) as KnowledgeEntry[];
    all.push(...raw);
  }
  return all;
}
