import { readFileSync, writeFileSync } from 'node:fs';
import {
  expiresMsFromCliEntry,
  grokCliAccountId,
  grokCliAuthPath,
  preferredGrokCliAuthKey,
  readGrokCliAuthFile,
  updateGrokCliAuthTokens,
  writeGrokCliAuthFile,
} from '../auth/cliAuth.js';
import { refresh } from '../auth/oauth.js';
import { type BillingUsage, fetchAllBillingUsage } from '../opencode/billing.js';

const DEFAULT_GROUP = 'default';
const DEFAULT_ROTATION_MODE = 'balanced';
const DEFAULT_ACCOUNT_RETRIES = 3;
const DEFAULT_REQUEST_RETRIES = 9;
const REFRESH_SKEW_MS = 120_000;

export type AccountRotationMode = 'balanced' | 'priority';
export type AccountPoolSource = 'accounts-file' | 'inline' | 'env' | 'grok-cli';

export type GrokAccount = {
  id: string;
  group: string;
  priority: number;
  disabled: boolean;
  access?: string;
  refresh?: string;
  expires?: number;
  tokenEndpoint?: string;
  /** auth.json map key when source is grok-cli */
  cliAuthKey?: string;
};

export type GrokAccountPool = {
  accounts: GrokAccount[];
  mode: AccountRotationMode;
  sourcePath?: string;
  source?: AccountPoolSource;
};

export type AccountQuotaBar = {
  period: 'weekly' | 'monthly';
  label: string;
  percentUsed: number;
  billingPeriodEnd: string;
  billingPeriodStart?: string;
  used?: number;
  limit?: number;
  remaining?: number;
  productUsage?: { product: string; usagePercent: number }[];
};

export type AccountQuota = {
  weekly?: AccountQuotaBar;
  monthly?: AccountQuotaBar;
  weeklyError?: string;
  monthlyError?: string;
};

export type GrokAccountSummary = {
  id: string;
  group: string;
  priority: number;
  disabled: boolean;
  hasAccess: boolean;
  hasRefresh: boolean;
  expires?: number;
  tokenEndpoint?: string;
  quota?: AccountQuota;
  quotaError?: string;
};

export type AccountEnvironment = Record<string, string | undefined>;

const cursors = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseJsonSource(env: AccountEnvironment) {
  const inline = env.GROK_BUILD_ACCOUNT_GROUPS ?? env.GROK_BUILD_ACCOUNTS;
  if (inline?.trim()) return { source: parseJson(inline), sourcePath: undefined };
  if (!env.GROK_BUILD_ACCOUNTS_FILE?.trim()) return undefined;
  return {
    source: parseJson(readFileSync(env.GROK_BUILD_ACCOUNTS_FILE, 'utf8')),
    sourcePath: env.GROK_BUILD_ACCOUNTS_FILE,
  };
}

function accessFromRecord(value: Record<string, unknown>) {
  return (
    optionalString(value.access) ??
    optionalString(value.accessToken) ??
    optionalString(value.oauthToken) ??
    optionalString(value.token)
  );
}

function refreshFromRecord(value: Record<string, unknown>) {
  return optionalString(value.refresh) ?? optionalString(value.refreshToken);
}

function expiresFromRecord(value: Record<string, unknown>) {
  const expires = optionalNumber(value.expires);
  if (expires !== undefined) return expires < 10_000_000_000 ? expires * 1000 : expires;

  const expiresAt = optionalString(value.expiresAt);
  if (!expiresAt) return undefined;

  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function accountFromRecord(
  value: unknown,
  fallbackGroup: string,
  fallbackId: string,
): GrokAccount | undefined {
  if (!isRecord(value)) return undefined;

  const access = accessFromRecord(value);
  const refreshToken = refreshFromRecord(value);
  const expires = expiresFromRecord(value);
  const tokenEndpoint = optionalString(value.tokenEndpoint);
  if (!access && !refreshToken) return undefined;

  return {
    id: optionalString(value.id) ?? optionalString(value.name) ?? fallbackId,
    group: optionalString(value.group) ?? fallbackGroup,
    priority: optionalNumber(value.priority) ?? 0,
    disabled: optionalBoolean(value.disabled) ?? false,
    ...(access ? { access } : {}),
    ...(refreshToken ? { refresh: refreshToken } : {}),
    ...(expires !== undefined ? { expires } : {}),
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
  };
}

function accountsFromTokens(value: Record<string, unknown>, group: string) {
  return Array.isArray(value.tokens)
    ? value.tokens
        .map(optionalString)
        .filter((token): token is string => !!token)
        .map((token, index) => ({
          id: `${group}-${index + 1}`,
          group,
          priority: optionalNumber(value.priority) ?? 0,
          disabled: false,
          access: token,
        }))
    : [];
}

function accountsFromGroup(value: unknown, fallbackGroup = DEFAULT_GROUP): GrokAccount[] {
  if (!isRecord(value)) return [];

  const group =
    optionalString(value.group) ??
    optionalString(value.id) ??
    optionalString(value.name) ??
    fallbackGroup;
  const groupedAccounts = Array.isArray(value.accounts)
    ? value.accounts
        .map((account, index) => accountFromRecord(account, group, `${group}-${index + 1}`))
        .filter((account): account is GrokAccount => !!account)
    : [];

  return [...groupedAccounts, ...accountsFromTokens(value, group)];
}

function accountsFromSource(source: unknown): GrokAccount[] {
  if (Array.isArray(source)) {
    return source.flatMap((item, index) => {
      if (isRecord(item) && (Array.isArray(item.accounts) || Array.isArray(item.tokens))) {
        return accountsFromGroup(item);
      }
      const account = accountFromRecord(item, DEFAULT_GROUP, `${DEFAULT_GROUP}-${index + 1}`);
      return account ? [account] : [];
    });
  }

  if (!isRecord(source)) return [];
  if (Array.isArray(source.groups)) {
    return source.groups.flatMap((group) => accountsFromGroup(group));
  }
  if (Array.isArray(source.accounts)) {
    const group =
      optionalString(source.defaultGroup) ?? optionalString(source.group) ?? DEFAULT_GROUP;
    return [
      ...source.accounts
        .map((account, index) => accountFromRecord(account, group, `${group}-${index + 1}`))
        .filter((account): account is GrokAccount => !!account),
      ...accountsFromTokens(source, group),
    ];
  }

  const account = accountFromRecord(source, DEFAULT_GROUP, DEFAULT_GROUP);
  return account ? [account] : [];
}

function modeFromValue(value: unknown): AccountRotationMode | undefined {
  const mode = optionalString(value)?.toLowerCase();
  if (mode === 'priority') return 'priority';
  if (mode === 'balanced') return 'balanced';
  return undefined;
}

function modeFromSource(source: unknown) {
  return isRecord(source) ? modeFromValue(source.mode ?? source.loadBalancingMode) : undefined;
}

function legacyAccount(env: AccountEnvironment): GrokAccount[] {
  const access = env.GROK_BUILD_OAUTH_TOKEN ?? env.GROK_BUILD_ACCESS_TOKEN;
  return access
    ? [
        {
          id: 'env',
          group: DEFAULT_GROUP,
          priority: 0,
          disabled: false,
          access,
        },
      ]
    : [];
}

function grokCliAccounts(env: AccountEnvironment): {
  accounts: GrokAccount[];
  sourcePath: string;
} {
  const sourcePath = grokCliAuthPath(env);
  let auth: ReturnType<typeof readGrokCliAuthFile> = {};
  try {
    auth = readGrokCliAuthFile(sourcePath);
  } catch {
    return { accounts: [], sourcePath };
  }
  const accounts = Object.entries(auth).flatMap(([authKey, entry], index) => {
    const expires = expiresMsFromCliEntry(entry);
    const refreshToken =
      typeof entry.refresh_token === 'string' && entry.refresh_token.trim()
        ? entry.refresh_token.trim()
        : undefined;
    return [
      {
        id: grokCliAccountId(entry, `grok-cli-${index + 1}`),
        group: DEFAULT_GROUP,
        priority: index,
        disabled: false,
        access: entry.key,
        cliAuthKey: authKey,
        ...(refreshToken ? { refresh: refreshToken } : {}),
        ...(expires !== undefined ? { expires } : {}),
      } satisfies GrokAccount,
    ];
  });
  return { accounts, sourcePath };
}

export function resolveAccountPool(env: AccountEnvironment = process.env): GrokAccountPool {
  const parsed = parseJsonSource(env);
  const mode =
    modeFromValue(env.GROK_BUILD_LOAD_BALANCING_MODE) ??
    modeFromValue(env.GROK_BUILD_ACCOUNT_ROTATION) ??
    modeFromSource(parsed?.source) ??
    DEFAULT_ROTATION_MODE;

  if (parsed) {
    return {
      accounts: accountsFromSource(parsed.source),
      mode,
      source: parsed.sourcePath ? 'accounts-file' : 'inline',
      ...(parsed.sourcePath ? { sourcePath: parsed.sourcePath } : {}),
    };
  }

  const legacy = legacyAccount(env);
  if (legacy.length > 0) {
    return { accounts: legacy, mode, source: 'env' };
  }

  // Fall back to credentials from `grok login` (~/.grok/auth.json).
  if (env.GROK_BUILD_DISABLE_CLI_AUTH === '1' || env.GROK_BUILD_DISABLE_CLI_AUTH === 'true') {
    return { accounts: [], mode, source: 'env' };
  }

  const cli = grokCliAccounts(env);
  return {
    accounts: cli.accounts,
    mode,
    source: 'grok-cli',
    sourcePath: cli.sourcePath,
  };
}

export function accountGroupFromHeaders(headers: Headers, env: AccountEnvironment = process.env) {
  return (
    optionalString(headers.get('x-grok-account-group')) ??
    optionalString(headers.get('x-grok-build-account-group')) ??
    optionalString(env.GROK_BUILD_ACCOUNT_GROUP)
  );
}

export function accountKey(account: GrokAccount) {
  return `${account.group}:${account.id}`;
}

function cursorKey(pool: GrokAccountPool, group: string | undefined) {
  return JSON.stringify({
    group,
    mode: pool.mode,
    accounts: pool.accounts.map((account) => ({
      id: account.id,
      group: account.group,
      priority: account.priority,
      disabled: account.disabled,
    })),
  });
}

function sortedAccounts(accounts: GrokAccount[]) {
  return [...accounts].sort(
    (left, right) =>
      left.priority - right.priority ||
      left.group.localeCompare(right.group) ||
      left.id.localeCompare(right.id),
  );
}

export function selectAccount(
  pool: GrokAccountPool,
  group: string | undefined,
  attempts = new Map<string, number>(),
  perAccountLimit = DEFAULT_ACCOUNT_RETRIES,
) {
  const accounts = sortedAccounts(
    pool.accounts.filter(
      (account) =>
        !account.disabled &&
        (!group || account.group === group) &&
        (attempts.get(accountKey(account)) ?? 0) < perAccountLimit,
    ),
  );

  if (accounts.length === 0) return undefined;
  if (pool.mode === 'priority') return accounts[0];

  const key = cursorKey(pool, group);
  const next = cursors.get(key) ?? 0;
  cursors.set(key, next + 1);
  return accounts[next % accounts.length];
}

function tokenIsExpiring(expires: number | undefined) {
  if (expires === undefined) return false;
  return expires - Date.now() <= REFRESH_SKEW_MS;
}

function accountForWrite(account: GrokAccount) {
  return {
    id: account.id,
    group: account.group,
    priority: account.priority,
    ...(account.disabled ? { disabled: account.disabled } : {}),
    ...(account.access ? { access: account.access } : {}),
    ...(account.refresh ? { refresh: account.refresh } : {}),
    ...(account.expires !== undefined ? { expires: account.expires } : {}),
    ...(account.tokenEndpoint ? { tokenEndpoint: account.tokenEndpoint } : {}),
  };
}

function accountSummary(account: GrokAccount): GrokAccountSummary {
  return {
    id: account.id,
    group: account.group,
    priority: account.priority,
    disabled: account.disabled,
    hasAccess: !!account.access,
    hasRefresh: !!account.refresh,
    ...(account.expires !== undefined ? { expires: account.expires } : {}),
    ...(account.tokenEndpoint ? { tokenEndpoint: account.tokenEndpoint } : {}),
  };
}

export function accountSummaries(pool: GrokAccountPool): GrokAccountSummary[] {
  return sortedAccounts(pool.accounts).map(accountSummary);
}

function accountQuotaBarFromUsage(usage: BillingUsage): AccountQuotaBar {
  return {
    period: usage.period,
    label: usage.label,
    percentUsed: usage.percentUsed,
    billingPeriodEnd: usage.billingPeriodEnd,
    ...(usage.billingPeriodStart ? { billingPeriodStart: usage.billingPeriodStart } : {}),
    ...(usage.used !== undefined ? { used: usage.used } : {}),
    ...(usage.limit !== undefined ? { limit: usage.limit } : {}),
    ...(usage.remaining !== undefined ? { remaining: usage.remaining } : {}),
    ...(usage.productUsage?.length ? { productUsage: usage.productUsage } : {}),
  };
}

export async function accountSummariesWithQuota(
  pool: GrokAccountPool,
): Promise<GrokAccountSummary[]> {
  return Promise.all(
    sortedAccounts(pool.accounts).map(async (account) => {
      const summary = accountSummary(account);
      if (account.disabled) return { ...summary, quotaError: 'account disabled' };

      try {
        const token = await accountToken(pool, account);
        if (!token) return { ...summary, quotaError: 'no access token' };

        const all = await fetchAllBillingUsage(token);
        if (!all.weekly && !all.monthly) {
          return {
            ...summary,
            quotaError:
              [all.weeklyError, all.monthlyError].filter(Boolean).join('; ') || 'quota unavailable',
          };
        }

        return {
          ...summary,
          quota: {
            ...(all.weekly ? { weekly: accountQuotaBarFromUsage(all.weekly) } : {}),
            ...(all.monthly ? { monthly: accountQuotaBarFromUsage(all.monthly) } : {}),
            ...(all.weeklyError ? { weeklyError: all.weeklyError } : {}),
            ...(all.monthlyError ? { monthlyError: all.monthlyError } : {}),
          },
        };
      } catch (cause) {
        return {
          ...summary,
          quotaError: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }),
  );
}

function persistAccountsFile(pool: GrokAccountPool) {
  if (!pool.sourcePath) return;
  writeFileSync(
    pool.sourcePath,
    `${JSON.stringify(
      {
        mode: pool.mode,
        groups: Array.from(new Set(pool.accounts.map((account) => account.group))).map((group) => ({
          id: group,
          accounts: pool.accounts.filter((account) => account.group === group).map(accountForWrite),
        })),
      },
      null,
      2,
    )}\n`,
  );
}

function persistGrokCliAuth(pool: GrokAccountPool, account: GrokAccount) {
  if (!pool.sourcePath || pool.source !== 'grok-cli') return;
  if (!account.access || !account.refresh || account.expires === undefined) return;
  updateGrokCliAuthTokens(
    pool.sourcePath,
    {
      access: account.access,
      refresh: account.refresh,
      expires: account.expires,
    },
    process.env,
    account.cliAuthKey,
  );
}

function persistPool(pool: GrokAccountPool, account?: GrokAccount) {
  if (pool.source === 'grok-cli') {
    if (account) persistGrokCliAuth(pool, account);
    return;
  }
  if (pool.source === 'accounts-file' || pool.sourcePath) persistAccountsFile(pool);
}

export function exportAccountPoolJson(pool: GrokAccountPool) {
  const groups = Array.from(new Set(pool.accounts.map((account) => account.group))).map(
    (group) => ({
      id: group,
      accounts: pool.accounts.filter((account) => account.group === group).map(accountForWrite),
    }),
  );
  return {
    mode: pool.mode,
    groups,
    exportedAt: new Date().toISOString(),
  };
}

export function saveAccountToPoolFile(env: AccountEnvironment = process.env, account: GrokAccount) {
  const pool = resolveAccountPool(env);
  if (!pool.sourcePath || pool.source !== 'accounts-file') {
    throw new Error('GROK_BUILD_ACCOUNTS_FILE is required to save accounts from the admin UI.');
  }

  persistPool({
    ...pool,
    source: 'accounts-file',
    accounts: [
      ...pool.accounts.filter((existing) => accountKey(existing) !== accountKey(account)),
      account,
    ],
  });

  return resolveAccountPool(env);
}

export function importAccountsToPoolFile(
  env: AccountEnvironment = process.env,
  source: unknown,
  options: { mode?: 'merge' | 'replace' } = {},
) {
  if (!env.GROK_BUILD_ACCOUNTS_FILE?.trim()) {
    throw new Error('GROK_BUILD_ACCOUNTS_FILE is required to import accounts JSON.');
  }

  const imported = accountsFromSource(source);
  if (imported.length === 0) {
    throw new Error(
      'Import JSON must include accounts (array, { accounts }, or { groups: [{ accounts }] }).',
    );
  }

  const pool = resolveAccountPool(env);
  if (pool.source !== 'accounts-file' || !pool.sourcePath) {
    throw new Error('GROK_BUILD_ACCOUNTS_FILE is required to import accounts JSON.');
  }

  const mode = options.mode === 'replace' ? 'replace' : 'merge';
  const modeFromImport = modeFromSource(source);
  const nextAccounts =
    mode === 'replace'
      ? imported
      : [
          ...pool.accounts.filter(
            (existing) => !imported.some((account) => accountKey(account) === accountKey(existing)),
          ),
          ...imported,
        ];

  persistPool({
    ...pool,
    source: 'accounts-file',
    mode: modeFromImport ?? pool.mode,
    accounts: nextAccounts,
  });

  return resolveAccountPool(env);
}

export function removeAccountFromPoolFile(
  env: AccountEnvironment = process.env,
  target: { id: string; group?: string },
) {
  const pool = resolveAccountPool(env);
  if (pool.source === 'grok-cli' && pool.sourcePath) {
    const auth = readGrokCliAuthFile(pool.sourcePath);
    const match = pool.accounts.find(
      (account) =>
        account.id === target.id ||
        account.cliAuthKey === target.id ||
        (!!target.group && accountKey(account) === `${target.group}:${target.id}`),
    );
    const key = match?.cliAuthKey ?? preferredGrokCliAuthKey(auth, env);
    if (!key || !auth[key]) throw new Error(`Grok CLI account not found: ${target.id}`);
    const { [key]: _removed, ...rest } = auth;
    writeGrokCliAuthFile(pool.sourcePath, rest);
    return resolveAccountPool(env);
  }

  if (!pool.sourcePath || pool.source !== 'accounts-file') {
    throw new Error('GROK_BUILD_ACCOUNTS_FILE is required to remove accounts from the admin UI.');
  }

  const group = target.group?.trim() || DEFAULT_GROUP;
  const next = pool.accounts.filter(
    (account) => !(account.id === target.id && account.group === group),
  );
  if (next.length === pool.accounts.length) {
    throw new Error(`Account not found: ${group}:${target.id}`);
  }

  persistPool({ ...pool, source: 'accounts-file', accounts: next });
  return resolveAccountPool(env);
}

export function importGrokCliAuthToPoolFile(
  env: AccountEnvironment = process.env,
  group = DEFAULT_GROUP,
) {
  if (!env.GROK_BUILD_ACCOUNTS_FILE?.trim()) {
    throw new Error('GROK_BUILD_ACCOUNTS_FILE is required to import Grok CLI login credentials.');
  }

  const cli = grokCliAccounts(env);
  if (cli.accounts.length === 0) {
    throw new Error(
      `No credentials found in ${cli.sourcePath}. Run \`grok login\` first, then import.`,
    );
  }

  let pool = resolveAccountPool(env);
  if (pool.source !== 'accounts-file' || !pool.sourcePath) {
    throw new Error('GROK_BUILD_ACCOUNTS_FILE is required to import Grok CLI login credentials.');
  }

  for (const account of cli.accounts) {
    const imported: GrokAccount = {
      id: account.id,
      group,
      priority: account.priority,
      disabled: false,
      ...(account.access ? { access: account.access } : {}),
      ...(account.refresh ? { refresh: account.refresh } : {}),
      ...(account.expires !== undefined ? { expires: account.expires } : {}),
    };
    pool = {
      ...pool,
      accounts: [
        ...pool.accounts.filter((existing) => accountKey(existing) !== accountKey(imported)),
        imported,
      ],
    };
  }

  persistPool({ ...pool, source: 'accounts-file' });
  return resolveAccountPool(env);
}

export async function accountToken(pool: GrokAccountPool, account: GrokAccount) {
  if (account.access && !tokenIsExpiring(account.expires)) return account.access;
  if (!account.refresh) return account.access;

  const tokens = await refresh({
    access: account.access ?? '',
    refresh: account.refresh,
    expires: account.expires ?? 0,
    ...(account.tokenEndpoint ? { tokenEndpoint: account.tokenEndpoint } : {}),
  });
  account.access = tokens.access;
  account.refresh = tokens.refresh;
  account.expires = tokens.expires;
  account.tokenEndpoint = (tokens as Record<string, unknown>).tokenEndpoint as string | undefined;
  persistPool(pool, account);
  return account.access;
}

export function requestRetryLimit(env: AccountEnvironment = process.env) {
  return (
    optionalNumber(Number.parseInt(env.GROK_BUILD_ACCOUNT_REQUEST_RETRIES ?? '', 10)) ??
    DEFAULT_REQUEST_RETRIES
  );
}

export function accountRetryLimit(env: AccountEnvironment = process.env) {
  return (
    optionalNumber(Number.parseInt(env.GROK_BUILD_ACCOUNT_RETRIES ?? '', 10)) ??
    DEFAULT_ACCOUNT_RETRIES
  );
}

export function shouldRetryWithAnotherAccount(response: Response) {
  return (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 429 ||
    response.status >= 500
  );
}

export function accountFromOAuthCredentials(
  credentials: {
    access: string;
    refresh: string;
    expires: number;
    tokenEndpoint?: string;
  },
  group = DEFAULT_GROUP,
) {
  return {
    id: `xai-${new Date().toISOString()}`,
    group,
    priority: 0,
    access: credentials.access,
    refresh: credentials.refresh,
    expires: credentials.expires,
    ...(credentials.tokenEndpoint ? { tokenEndpoint: credentials.tokenEndpoint } : {}),
  };
}
