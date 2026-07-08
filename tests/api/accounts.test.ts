import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountGroupFromHeaders,
  accountKey,
  accountSummaries,
  accountSummariesWithQuota,
  exportAccountPoolJson,
  importAccountsToPoolFile,
  importGrokCliAuthToPoolFile,
  removeAccountFromPoolFile,
  resolveAccountPool,
  saveAccountToPoolFile,
  selectAccount,
} from '../../src/api/accounts.js';
import { billingJsonResponse, weeklyCreditsJsonResponse } from '../opencode/billingTestHelpers.js';

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
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
    const pool = resolveAccountPool({
      GROK_BUILD_ACCESS_TOKEN: 'legacy-token',
      GROK_BUILD_DISABLE_CLI_AUTH: '1',
    });

    expect(pool.accounts).toEqual([
      {
        id: 'env',
        group: 'default',
        priority: 0,
        disabled: false,
        access: 'legacy-token',
      },
    ]);
    expect(pool.source).toBe('env');
  });

  it('loads grok login credentials from ~/.grok/auth.json when no pool is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-cli-auth-'));
    tempDirs.push(dir);
    const authPath = join(dir, 'auth.json');
    writeFileSync(
      authPath,
      JSON.stringify({
        'https://auth.x.ai::client': {
          key: 'cli-access',
          refresh_token: 'cli-refresh',
          expires_at: '2030-01-01T00:00:00.000Z',
          email: 'user@example.com',
        },
      }),
    );

    const pool = resolveAccountPool({ GROK_AUTH_FILE: authPath });

    expect(pool.source).toBe('grok-cli');
    expect(pool.sourcePath).toBe(authPath);
    expect(pool.accounts).toEqual([
      {
        id: 'user@example.com',
        group: 'default',
        priority: 0,
        disabled: false,
        access: 'cli-access',
        refresh: 'cli-refresh',
        expires: Date.parse('2030-01-01T00:00:00.000Z'),
        cliAuthKey: 'https://auth.x.ai::client',
      },
    ]);
  });

  it('imports grok login credentials into the accounts file and supports logout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-import-'));
    tempDirs.push(dir);
    const accountsPath = join(dir, 'accounts.json');
    const authPath = join(dir, 'auth.json');
    writeFileSync(accountsPath, '{"mode":"balanced","groups":[]}');
    writeFileSync(
      authPath,
      JSON.stringify({
        'https://auth.x.ai::client': {
          key: 'cli-access',
          refresh_token: 'cli-refresh',
          expires_at: '2030-01-01T00:00:00.000Z',
          email: 'user@example.com',
        },
      }),
    );

    const imported = importGrokCliAuthToPoolFile(
      {
        GROK_BUILD_ACCOUNTS_FILE: accountsPath,
        GROK_AUTH_FILE: authPath,
      },
      'personal',
    );

    expect(imported.accounts).toMatchObject([
      {
        id: 'user@example.com',
        group: 'personal',
        access: 'cli-access',
        refresh: 'cli-refresh',
      },
    ]);

    const afterLogout = removeAccountFromPoolFile(
      { GROK_BUILD_ACCOUNTS_FILE: accountsPath },
      { id: 'user@example.com', group: 'personal' },
    );
    expect(afterLogout.accounts).toEqual([]);
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

  it('exports and imports account pool JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-export-'));
    tempDirs.push(dir);
    const accountsPath = join(dir, 'accounts.json');
    writeFileSync(accountsPath, '{"mode":"balanced","groups":[]}');

    saveAccountToPoolFile(
      { GROK_BUILD_ACCOUNTS_FILE: accountsPath },
      {
        id: 'one',
        group: 'default',
        priority: 0,
        disabled: false,
        access: 'access-1',
        refresh: 'refresh-1',
      },
    );

    const exported = exportAccountPoolJson(
      resolveAccountPool({ GROK_BUILD_ACCOUNTS_FILE: accountsPath }),
    );
    expect(exported).toMatchObject({
      mode: 'balanced',
      groups: [
        { id: 'default', accounts: [{ id: 'one', access: 'access-1', refresh: 'refresh-1' }] },
      ],
    });

    const merged = importAccountsToPoolFile(
      { GROK_BUILD_ACCOUNTS_FILE: accountsPath },
      {
        mode: 'priority',
        groups: [
          {
            id: 'default',
            accounts: [{ id: 'two', access: 'access-2', refresh: 'refresh-2' }],
          },
        ],
      },
      { mode: 'merge' },
    );
    expect(merged.accounts.map((account) => account.id).sort()).toEqual(['one', 'two']);
    expect(merged.mode).toBe('priority');

    const replaced = importAccountsToPoolFile(
      { GROK_BUILD_ACCOUNTS_FILE: accountsPath },
      {
        groups: [{ id: 'work', accounts: [{ id: 'only', access: 'only-access' }] }],
      },
      { mode: 'replace' },
    );
    expect(replaced.accounts).toMatchObject([{ id: 'only', group: 'work', access: 'only-access' }]);
  });

  it('includes weekly and monthly billing quota for each account summary', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('format=credits')) return weeklyCreditsJsonResponse(5);
      return billingJsonResponse(4000, 800, '2026-08-01T00:00:00+00:00');
    });

    const pool = resolveAccountPool({
      GROK_BUILD_ACCOUNTS: JSON.stringify([
        { id: 'a', access: 'token-a', group: 'default' },
        { id: 'b', access: 'token-b', group: 'default', disabled: true },
      ]),
      GROK_BUILD_DISABLE_CLI_AUTH: '1',
    });

    const summaries = await accountSummariesWithQuota(pool);
    expect(summaries).toMatchObject([
      {
        id: 'a',
        quota: {
          weekly: {
            period: 'weekly',
            label: 'Weekly SuperGrok Limit',
            percentUsed: 5,
          },
          monthly: {
            period: 'monthly',
            label: 'Monthly credits',
            used: 800,
            limit: 4000,
            remaining: 3200,
            percentUsed: 20,
            billingPeriodEnd: '2026-08-01T00:00:00+00:00',
          },
        },
      },
      {
        id: 'b',
        disabled: true,
        quotaError: 'account disabled',
      },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
