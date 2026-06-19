import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accountGroupFromHeaders,
  accountKey,
  accountSummaries,
  resolveAccountPool,
  saveAccountToPoolFile,
  selectAccount,
} from '../../src/api/accounts.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

  it('summarizes and saves accounts without exposing token values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-accounts-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'accounts.json'), '{"mode":"balanced","groups":[]}');

    const pool = saveAccountToPoolFile(
      { GROK_BUILD_ACCOUNTS_FILE: join(dir, 'accounts.json') },
      {
        id: 'saved',
        group: 'default',
        priority: 0,
        disabled: false,
        access: 'access-token',
        refresh: 'refresh-token',
        expires: 1_800_000_000_000,
        tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      },
    );

    expect(accountSummaries(pool)).toEqual([
      {
        id: 'saved',
        group: 'default',
        priority: 0,
        disabled: false,
        hasAccess: true,
        hasRefresh: true,
        expires: 1_800_000_000_000,
        tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      },
    ]);
    expect(JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'))).toMatchObject({
      groups: [{ id: 'default', accounts: [{ id: 'saved', refresh: 'refresh-token' }] }],
    });
  });
});
