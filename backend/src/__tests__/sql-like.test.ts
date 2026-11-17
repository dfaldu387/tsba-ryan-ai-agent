import { describe, expect, it } from 'vitest';
import { likePrefix } from '../sql-like.js';

describe('likePrefix', () => {
  it('escapes LIKE wildcards so an id cannot match other rows', () => {
    expect(likePrefix('drive:abc:')).toBe('drive:abc:%');
    expect(likePrefix('%')).toBe(String.raw`\%%`); // would otherwise delete every entry
    expect(likePrefix('drive:a_b:')).toBe(String.raw`drive:a\_b:%`); // Drive ids contain "_"
    expect(likePrefix(String.raw`x\y`)).toBe(String.raw`x\\y%`);
  });
});
