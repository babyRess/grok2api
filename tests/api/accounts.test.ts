import { describe, expect, it } from 'vitest';
import {
  accountGroupFromHeaders,
  accountKey,
  resolveAccountPool,
  selectAccount,
} from '../../src/api/accounts.js';

describe('Grok Build account pool', () => {
  it('parses grouped accounts and rotates within the requested group', () => {
    const pool = resolveAccountPool({
      GROK_BUILD_ACCOUNTS: JSON.stringify({
        mode: 'balanced',
        groups: [
          {
            id: 'work',
            accounts: [
              { id: 'work-a', access: 'token-a', priority: 1 },
              { id: 'work-b', accessToken: 'token-b', priority: 2 },
            ],
          },
          {
            id: 'personal',
            tokens: ['token-c'],
          },
        ],
      }),
    });

    expect(pool.mode).toBe('balanced');
    expect(pool.accounts.map(accountKey)).toEqual([
      'work:work-a',
      'work:work-b',
      'personal:personal-1',
    ]);

    expect(selectAccount(pool, 'work')?.access).toBe('token-a');
    expect(selectAccount(pool, 'work')?.access).toBe('token-b');
  });

  it('keeps legacy single-token env configuration working', () => {
    const pool = resolveAccountPool({ GROK_BUILD_ACCESS_TOKEN: 'legacy-token' });

    expect(pool.accounts).toEqual([
      {
        id: 'env',
        group: 'default',
        priority: 0,
        disabled: false,
        access: 'legacy-token',
      },
    ]);
  });

  it('resolves requested account group from headers before env defaults', () => {
    expect(
      accountGroupFromHeaders(new Headers({ 'x-grok-account-group': 'team-a' }), {
        GROK_BUILD_ACCOUNT_GROUP: 'team-b',
      }),
    ).toBe('team-a');
    expect(accountGroupFromHeaders(new Headers(), { GROK_BUILD_ACCOUNT_GROUP: 'team-b' })).toBe(
      'team-b',
    );
  });
});
