import { describe, expect, it } from 'vitest';
import { MemoryDraftStore } from '../stores/memory.js';
import { DraftAlreadyDecidedError } from '../draft-errors.js';
import type { InsertDraftArgs } from '../stores/types.js';

const args = {
  question: 'Inverter shows F35?',
  audience: 'customer',
  channel: 'email',
  result: { outcome: 'answer', reply: 'Check the grid connection.', sources: [], note_for_ryan: '', team_handover: null },
  sources: [],
  recipient: 'owner@example.com',
} as unknown as InsertDraftArgs;

describe('draft approval', () => {
  it('can only be approved or rejected once (no double send)', async () => {
    const store = new MemoryDraftStore();
    const d = await store.insert(args);
    expect((await store.update(d.id, 'approve'))?.status).toBe('sent');
    await expect(store.update(d.id, 'approve')).rejects.toBeInstanceOf(DraftAlreadyDecidedError);
    await expect(store.update(d.id, 'reject')).rejects.toBeInstanceOf(DraftAlreadyDecidedError);
  });

  it('editing a pending draft still works', async () => {
    const store = new MemoryDraftStore();
    const d = await store.insert(args);
    expect((await store.update(d.id, 'edit', 'New text'))?.reply).toBe('New text');
  });

  it('returns null for a draft that does not exist', async () => {
    expect(await new MemoryDraftStore().update(999, 'approve')).toBeNull();
  });
});
