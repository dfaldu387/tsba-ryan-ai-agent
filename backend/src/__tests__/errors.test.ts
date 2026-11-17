import { describe, expect, it, vi } from 'vitest';
import { UserError, publicMessage } from '../errors.js';

describe('publicMessage', () => {
  it('passes through messages written for users', () => {
    expect(publicMessage(new UserError('"x" is not a valid email address.'), 'fallback')).toBe('"x" is not a valid email address.');
  });

  it('hides internal errors behind the fallback and logs the real one', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const internal = new Error('connect ECONNREFUSED 10.0.0.5:5432 relation "drafts" does not exist');
    expect(publicMessage(internal, 'Couldn’t save. Try again.')).toBe('Couldn’t save. Try again.');
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0][1])).toContain('ECONNREFUSED');
    log.mockRestore();
  });
});
