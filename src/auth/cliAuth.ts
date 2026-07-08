/**
 * Read / update credentials written by the official Grok CLI (`grok login`).
 * Stored at ~/.grok/auth.json under issuer::client_id keys.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

export type GrokCliAuthEntry = {
  key: string;
  refresh_token?: string;
  expires_at?: string;
  email?: string;
  user_id?: string;
  principal_id?: string;
  oidc_client_id?: string;
  oidc_issuer?: string;
  [field: string]: unknown;
};

export type GrokCliAuthFile = Record<string, GrokCliAuthEntry>;

export function grokCliAuthPath(env: Record<string, string | undefined> = process.env) {
  if (env.GROK_AUTH_FILE?.trim()) return env.GROK_AUTH_FILE.trim();
  if (env.GROK_BUILD_CLI_AUTH_FILE?.trim()) return env.GROK_BUILD_CLI_AUTH_FILE.trim();
  return join(homedir(), '.grok', 'auth.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function entryFromUnknown(value: unknown): GrokCliAuthEntry | undefined {
  if (!isRecord(value)) return undefined;
  const key = typeof value.key === 'string' ? value.key.trim() : '';
  if (!key) return undefined;
  return value as GrokCliAuthEntry;
}

export function readGrokCliAuthFile(path: string): GrokCliAuthFile {
  if (!existsSync(path)) return {};
  const payload = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(payload)) return {};

  return Object.fromEntries(
    Object.entries(payload).flatMap(([id, value]) => {
      const entry = entryFromUnknown(value);
      return entry ? [[id, entry] as const] : [];
    }),
  );
}

export function writeGrokCliAuthFile(path: string, auth: GrokCliAuthFile) {
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`);
}

export function preferredGrokCliAuthKey(
  auth: GrokCliAuthFile,
  env: Record<string, string | undefined> = process.env,
) {
  const clientId = env.GROK_BUILD_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID;
  const preferred = `https://auth.x.ai::${clientId}`;
  if (auth[preferred]) return preferred;
  return Object.keys(auth)[0];
}

export function grokCliAccountId(entry: GrokCliAuthEntry, fallback: string) {
  return entry.email?.trim() || entry.user_id?.trim() || entry.principal_id?.trim() || fallback;
}

export function expiresMsFromCliEntry(entry: GrokCliAuthEntry) {
  if (!entry.expires_at) return undefined;
  const parsed = Date.parse(entry.expires_at);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function updateGrokCliAuthTokens(
  path: string,
  tokens: { access: string; refresh: string; expires: number },
  env: Record<string, string | undefined> = process.env,
  authKey?: string,
) {
  const auth = readGrokCliAuthFile(path);
  const key =
    (authKey && auth[authKey] ? authKey : undefined) ?? preferredGrokCliAuthKey(auth, env);
  if (!key || !auth[key]) return false;

  auth[key] = {
    ...auth[key],
    key: tokens.access,
    refresh_token: tokens.refresh,
    expires_at: new Date(tokens.expires).toISOString(),
  };
  writeGrokCliAuthFile(path, auth);
  return true;
}

export function logoutGrokCliAuth(
  path: string,
  env: Record<string, string | undefined> = process.env,
) {
  if (!existsSync(path)) return { removed: false, path };
  const auth = readGrokCliAuthFile(path);
  const key = preferredGrokCliAuthKey(auth, env);
  if (!key || !auth[key]) return { removed: false, path };

  const { [key]: _removed, ...rest } = auth;
  writeGrokCliAuthFile(path, rest);
  return { removed: true, path, key };
}
