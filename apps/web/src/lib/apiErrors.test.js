import { describe, expect, it } from 'vitest';
import { humanizeApiError } from './api';

/**
 * The un-migrated financial handlers surface their internals. A failed Supabase
 * call arrives as the literal string "TypeError: fetch failed", and that was
 * rendered to the user under "Couldn't load the Chart of Accounts" — which
 * explains nothing and reads like a crash.
 */
describe('humanizeApiError', () => {
  it('replaces exception text with something a person can act on', () => {
    for (const raw of [
      'TypeError: fetch failed',
      'Error: connect ECONNREFUSED 127.0.0.1:9',
      'FetchError: request to https://x failed',
      'getaddrinfo ENOTFOUND supabase.internal',
      'socket hang up',
    ]) {
      const msg = humanizeApiError(raw, 500);
      expect(msg).not.toContain('TypeError');
      expect(msg).not.toContain('ECONNREFUSED');
      expect(msg).not.toContain('ENOTFOUND');
      expect(msg.length).toBeGreaterThan(20);
    }
  });

  it('passes through a message that was written for a user', () => {
    const written = 'Provide exactly one of user_id or group_id.';
    expect(humanizeApiError(written, 400)).toBe(written);
    expect(humanizeApiError('Due date is required', 400)).toBe('Due date is required');
  });

  it('explains the common statuses when the server says nothing useful', () => {
    expect(humanizeApiError('', 401)).toMatch(/sign in/i);
    expect(humanizeApiError('', 403)).toMatch(/access/i);
    expect(humanizeApiError('', 404)).toMatch(/no longer available/i);
    expect(humanizeApiError('', 500)).toMatch(/server/i);
    expect(humanizeApiError('', 503)).toMatch(/server/i);
  });

  it('never returns an empty string', () => {
    for (const [raw, status] of [[undefined, 500], [null, 400], ['', 418]]) {
      expect(humanizeApiError(raw, status).trim().length).toBeGreaterThan(0);
    }
  });

  it('does not mistake ordinary prose beginning with a capital for an exception', () => {
    // "Error" as a prefix is the signal; a sentence that merely starts with a
    // capitalised word is not.
    expect(humanizeApiError('Company not found.', 404)).toBe('Company not found.');
  });
});
