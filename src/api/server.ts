import { spawn } from 'node:child_process';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { platform } from 'node:os';
import { beginGrokBuildOAuth } from '../auth/oauth.js';
import {
  accountFromOAuthCredentials,
  accountGroupFromHeaders,
  accountKey,
  accountRetryLimit,
  accountSummaries,
  accountToken,
  type GrokAccount,
  type GrokAccountPool,
  requestRetryLimit,
  resolveAccountPool,
  saveAccountToPoolFile,
  selectAccount,
  shouldRetryWithAnotherAccount,
} from './accounts.js';
import {
  type AnthropicApiEnvironment,
  AnthropicApiError,
  anthropicErrorResponse,
  anthropicMessagesToResponsesPayload,
  anthropicModelsPayload,
  anthropicToolNamesFromRequest,
  clientAuthError,
  countAnthropicTokens,
  grokResponsesHeaders,
  openAIChatCompletionToAnthropicMessages,
  openAIToolNamesFromRequest,
  responsesJsonToAnthropicMessage,
  responsesJsonToOpenAIChatCompletion,
  responsesStreamToAnthropicSse,
  responsesStreamToOpenAIChatCompletionsSse,
  sessionIdFromHeaders,
  type ToolUseConversionOptions,
  upstreamResponsesUrl,
} from './anthropic.js';
import {
  isWebSearchOnlyRequest,
  nativeWebSearchResponsesPayload,
  webSearchAnthropicResponse,
  webSearchAnthropicResponseFromGrok,
} from './websearch.js';

export type AnthropicApiHandlerOptions = {
  cwd?: string;
  env?: AnthropicApiEnvironment;
  fetch?: typeof fetch;
};

export type AnthropicApiServerOptions = AnthropicApiHandlerOptions & {
  host?: string;
  port?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value !== 'number' || !Number.isFinite(value) ? undefined : value;
}

function normalizedPath(request: Request) {
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '');
  return pathname || '/';
}

async function requestJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AnthropicApiError(400, 'invalid_request_error', 'Request body must be valid JSON.');
  }
}

async function upstreamErrorResponse(response: Response) {
  const text = await response.text();
  let message = text.trim() || `Upstream Grok Build request failed with ${response.status}.`;

  try {
    const payload = JSON.parse(text) as unknown;
    if (
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      payload.error &&
      typeof payload.error === 'object' &&
      'message' in payload.error &&
      typeof payload.error.message === 'string'
    ) {
      message = payload.error.message;
    }
  } catch {
    // Keep the upstream text body as the message.
  }

  return anthropicErrorResponse(response.status, message);
}

function routeIsMessages(pathname: string) {
  return pathname === '/v1/messages' || pathname === '/cc/v1/messages';
}

function routeIsChatCompletions(pathname: string) {
  return pathname === '/v1/chat/completions';
}

function routeIsCountTokens(pathname: string) {
  return pathname === '/v1/messages/count_tokens' || pathname === '/cc/v1/messages/count_tokens';
}

type LoginSession = {
  id: string;
  group: string;
  url: string;
  instructions: string;
  status: 'pending' | 'success' | 'failed';
  createdAt: number;
  expiresAt: number;
  account?: ReturnType<typeof accountFromOAuthCredentials>;
  error?: string;
};

const loginSessions = new Map<string, LoginSession>();
const LOGIN_SESSION_TTL_MS = 10 * 60_000;

function cleanupLoginSessions() {
  const now = Date.now();
  for (const [id, session] of loginSessions) {
    if (session.expiresAt <= now) loginSessions.delete(id);
  }
}

function loginPage() {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Grok Build admin</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; background: Canvas; color: CanvasText; }
    main { width: min(1120px, calc(100vw - 32px)); margin: 28px auto; display: grid; gap: 18px; }
    header { display: flex; align-items: end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    h1, h2, h3, p { margin: 0; letter-spacing: 0; }
    h1 { font-size: 24px; line-height: 1.2; }
    h2 { font-size: 16px; line-height: 1.3; }
    h3 { font-size: 14px; line-height: 1.3; }
    p, .muted { color: color-mix(in srgb, CanvasText 68%, Canvas 32%); line-height: 1.5; }
    .grid { display: grid; grid-template-columns: minmax(280px, 0.85fr) minmax(360px, 1.15fr); gap: 18px; align-items: start; }
    section, form { border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas 82%); border-radius: 8px; padding: 16px; display: grid; gap: 14px; }
    label { display: grid; gap: 7px; font-size: 13px; font-weight: 650; }
    input, textarea { width: 100%; box-sizing: border-box; border: 1px solid color-mix(in srgb, CanvasText 24%, Canvas 76%); border-radius: 6px; padding: 10px 11px; font: inherit; background: Canvas; color: CanvasText; }
    textarea { min-height: 220px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.45; }
    button, a.button { border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas 78%); border-radius: 6px; padding: 10px 12px; font: inherit; font-weight: 650; background: CanvasText; color: Canvas; text-decoration: none; cursor: pointer; }
    button.secondary, a.secondary { background: Canvas; color: CanvasText; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
    .hidden { display: none; }
    .status { min-height: 22px; font-size: 13px; }
    .records { display: grid; gap: 10px; }
    .record { border: 1px solid color-mix(in srgb, CanvasText 14%, Canvas 86%); border-radius: 8px; padding: 12px; display: grid; gap: 8px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .tag { border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas 82%); border-radius: 6px; padding: 3px 7px; font-size: 12px; color: color-mix(in srgb, CanvasText 76%, Canvas 24%); }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    @media (max-width: 820px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Grok Build admin</h1>
        <p>Manage account groups for the Anthropic-compatible gateway.</p>
      </div>
      <button id="refresh" type="button" class="secondary">Refresh accounts</button>
    </header>
    <div class="grid">
      <section>
        <h2>Accounts</h2>
        <div id="pool-meta" class="muted">Enter the local API key to load accounts.</div>
        <div id="accounts" class="records"></div>
      </section>
      <section>
        <h2>Add account</h2>
        <form id="login-form">
          <label>Local API key
            <input id="api-key" name="apiKey" type="password" autocomplete="off" placeholder="GROK_BUILD_API_KEY">
          </label>
          <label>Account group
            <input id="group" name="group" autocomplete="off" placeholder="default" value="default">
          </label>
          <div class="actions">
            <button id="start" type="submit">Create login session</button>
            <button id="private" type="button" class="secondary" disabled>Open private login</button>
            <a id="normal" class="button secondary hidden" target="_blank" rel="noreferrer">Open login URL</a>
          </div>
          <div id="status" class="status"></div>
        </form>
        <div id="result" class="hidden">
          <label>Account JSON
            <textarea id="account-json" readonly></textarea>
          </label>
          <div class="actions">
            <button id="save" type="button">Save to account file</button>
            <button id="copy" type="button" class="secondary">Copy JSON</button>
          </div>
        </div>
      </section>
    </div>
  </main>
  <script>
    const form = document.querySelector('#login-form');
    const status = document.querySelector('#status');
    const poolMeta = document.querySelector('#pool-meta');
    const accounts = document.querySelector('#accounts');
    const refreshButton = document.querySelector('#refresh');
    const privateButton = document.querySelector('#private');
    const normalLink = document.querySelector('#normal');
    const result = document.querySelector('#result');
    const accountJson = document.querySelector('#account-json');
    const copyButton = document.querySelector('#copy');
    const saveButton = document.querySelector('#save');
    const apiKeyInput = document.querySelector('#api-key');
    const groupInput = document.querySelector('#group');
    let sessionId;
    let timer;
    let latestAccount;

    const headers = () => {
      const apiKey = apiKeyInput.value.trim();
      return apiKey ? { 'content-type': 'application/json', 'x-api-key': apiKey } : { 'content-type': 'application/json' };
    };

    const renderAccounts = (payload) => {
      poolMeta.textContent = payload.sourcePath
        ? 'Source: ' + payload.sourcePath + ' · mode: ' + payload.mode
        : 'No GROK_BUILD_ACCOUNTS_FILE is configured.';
      accounts.innerHTML = '';
      if (!payload.accounts?.length) {
        accounts.innerHTML = '<div class="record muted">No accounts saved yet.</div>';
        return;
      }
      for (const account of payload.accounts) {
        const record = document.createElement('div');
        record.className = 'record';
        const expires = account.expires ? new Date(account.expires).toLocaleString() : 'no expiry';
        record.innerHTML =
          '<div class="row"><h3>' + account.id + '</h3><span class="tag">' + account.group + '</span></div>' +
          '<div class="row muted"><span>priority ' + account.priority + '</span><span>' + expires + '</span></div>' +
          '<div class="row"><span class="tag">' + (account.hasAccess ? 'access' : 'no access') + '</span><span class="tag">' + (account.hasRefresh ? 'refresh' : 'no refresh') + '</span></div>';
        accounts.appendChild(record);
      }
    };

    const loadAccounts = async () => {
      poolMeta.textContent = 'Loading accounts...';
      const response = await fetch('/auth/grok-build/accounts', { headers: headers() });
      const payload = await response.json();
      if (!response.ok) {
        poolMeta.textContent = payload.error?.message || 'Could not load accounts.';
        accounts.innerHTML = '';
        return;
      }
      renderAccounts(payload);
    };

    const poll = async () => {
      if (!sessionId) return;
      const response = await fetch('/auth/grok-build/sessions/' + sessionId, { headers: headers() });
      const payload = await response.json();
      if (payload.status === 'pending') {
        status.textContent = 'Waiting for OAuth callback...';
        return;
      }
      clearInterval(timer);
      if (payload.status === 'success') {
        status.textContent = 'Credential received.';
        latestAccount = payload.account;
        accountJson.value = JSON.stringify(payload.account, null, 2);
        result.classList.remove('hidden');
        return;
      }
      status.textContent = payload.error || 'Login failed.';
    };

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearInterval(timer);
      result.classList.add('hidden');
      status.textContent = 'Creating OAuth session...';
      const response = await fetch('/auth/grok-build/sessions', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ group: groupInput.value.trim() || 'default' })
      });
      const payload = await response.json();
      if (!response.ok) {
        status.textContent = payload.error?.message || 'Could not create login session.';
        return;
      }
      sessionId = payload.id;
      normalLink.href = payload.url;
      normalLink.classList.remove('hidden');
      privateButton.disabled = false;
      status.textContent = 'Open the login URL, then finish xAI authorization.';
      timer = setInterval(poll, 1500);
    });

    privateButton.addEventListener('click', async () => {
      if (!sessionId) return;
      status.textContent = 'Opening private browser window...';
      await fetch('/auth/grok-build/sessions/' + sessionId + '/open-private', {
        method: 'POST',
        headers: headers()
      });
      await poll();
    });

    copyButton.addEventListener('click', async () => {
      await navigator.clipboard.writeText(accountJson.value);
      status.textContent = 'Copied account JSON.';
    });

    saveButton.addEventListener('click', async () => {
      if (!latestAccount) return;
      status.textContent = 'Saving account...';
      const response = await fetch('/auth/grok-build/accounts', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ account: latestAccount })
      });
      const payload = await response.json();
      if (!response.ok) {
        status.textContent = payload.error?.message || 'Could not save account.';
        return;
      }
      status.textContent = 'Account saved.';
      renderAccounts(payload);
    });

    refreshButton.addEventListener('click', loadAccounts);
    apiKeyInput.addEventListener('change', loadAccounts);
    void loadAccounts();
  </script>
</body>
</html>`,
    {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  );
}

function loginSessionJson(session: LoginSession) {
  if (session.status === 'success') {
    return Response.json({
      status: session.status,
      group: session.group,
      account: session.account,
    });
  }
  if (session.status === 'failed') {
    return Response.json({
      status: session.status,
      group: session.group,
      error: session.error,
    });
  }
  return Response.json({
    status: session.status,
    group: session.group,
    url: session.url,
    instructions: session.instructions,
    expiresAt: session.expiresAt,
  });
}

function accountPoolJson(env: AnthropicApiEnvironment) {
  const pool = resolveAccountPool(env);
  return Response.json({
    mode: pool.mode,
    sourcePath: pool.sourcePath ?? null,
    writable: !!pool.sourcePath,
    accounts: accountSummaries(pool),
  });
}

function accountFromAdminPayload(value: unknown): GrokAccount {
  const payload = isRecord(value) && isRecord(value.account) ? value.account : value;
  if (!isRecord(payload)) {
    throw new AnthropicApiError(400, 'invalid_request_error', '`account` must be an object.');
  }

  const access = textField(payload.access);
  const refresh = textField(payload.refresh);
  const expires = numberField(payload.expires);
  const tokenEndpoint = textField(payload.tokenEndpoint);
  if (!access && !refresh) {
    throw new AnthropicApiError(
      400,
      'invalid_request_error',
      '`account.access` or `account.refresh` is required.',
    );
  }

  return {
    id: textField(payload.id) ?? `xai-${new Date().toISOString()}`,
    group: textField(payload.group) ?? 'default',
    priority: numberField(payload.priority) ?? 0,
    disabled: payload.disabled === true,
    ...(access ? { access } : {}),
    ...(refresh ? { refresh } : {}),
    ...(expires !== undefined ? { expires } : {}),
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
  };
}

async function saveAdminAccount(request: Request, env: AnthropicApiEnvironment) {
  const pool = saveAccountToPoolFile(env, accountFromAdminPayload(await requestJson(request)));
  return Response.json({
    mode: pool.mode,
    sourcePath: pool.sourcePath ?? null,
    writable: !!pool.sourcePath,
    accounts: accountSummaries(pool),
  });
}

async function createLoginSession(request: Request) {
  cleanupLoginSessions();
  const body = await requestJson(request);
  const group =
    isRecord(body) && typeof body.group === 'string' && body.group.trim()
      ? body.group.trim()
      : 'default';
  const oauthSession = await beginGrokBuildOAuth('open-grok-build-api');
  const id = crypto.randomUUID();
  const session: LoginSession = {
    id,
    group,
    url: oauthSession.url,
    instructions: oauthSession.instructions,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + LOGIN_SESSION_TTL_MS,
  };
  loginSessions.set(id, session);

  void oauthSession.finish().then(
    (credentials) => {
      session.status = 'success';
      session.account = accountFromOAuthCredentials(
        {
          access: credentials.access,
          refresh: credentials.refresh,
          expires: credentials.expires,
          tokenEndpoint: credentials.tokenEndpoint as string | undefined,
        },
        group,
      );
      session.expiresAt = Date.now() + LOGIN_SESSION_TTL_MS;
    },
    (cause: unknown) => {
      session.status = 'failed';
      session.error = cause instanceof Error ? cause.message : String(cause);
      session.expiresAt = Date.now() + LOGIN_SESSION_TTL_MS;
    },
  );

  return Response.json({
    id,
    group,
    url: session.url,
    instructions: session.instructions,
    openPrivateUrl: `/auth/grok-build/sessions/${id}/open-private`,
  });
}

function privateBrowserCommand(url: string) {
  if (platform() === 'darwin') {
    return {
      command: 'open',
      args: ['-na', 'Google Chrome', '--args', '--incognito', url],
      label: 'Google Chrome Incognito',
    };
  }
  if (platform() === 'linux') {
    return {
      command: 'google-chrome',
      args: ['--incognito', url],
      label: 'Google Chrome Incognito',
    };
  }
  return undefined;
}

function openPrivateBrowser(url: string) {
  const command = privateBrowserCommand(url);
  if (!command) {
    return Response.json(
      {
        opened: false,
        message:
          'Private browser launch is supported on macOS and Linux. Use the login URL manually.',
      },
      { status: 501 },
    );
  }

  const child = spawn(command.command, command.args, { detached: true, stdio: 'ignore' });
  child.unref();
  return Response.json({ opened: true, target: command.label });
}

function loginSessionId(pathname: string) {
  return pathname.match(/^\/auth\/grok-build\/sessions\/([^/]+)(?:\/open-private)?$/)?.[1];
}

function handleLoginSessionRoute(request: Request, pathname: string) {
  cleanupLoginSessions();
  const id = loginSessionId(pathname);
  const session = id ? loginSessions.get(id) : undefined;
  if (!session) {
    return anthropicErrorResponse(404, `Login session not found: ${id ?? pathname}.`);
  }
  if (request.method === 'POST' && pathname.endsWith('/open-private')) {
    return openPrivateBrowser(session.url);
  }
  if (request.method === 'GET') return loginSessionJson(session);
  return anthropicErrorResponse(404, `Route not found: ${request.method} ${pathname}.`);
}

async function fetchUpstreamResponses(
  request: Request,
  options: AnthropicApiHandlerOptions,
  payload: Record<string, unknown>,
  pool: GrokAccountPool,
) {
  const model = typeof payload.model === 'string' ? payload.model : '';
  const env = options.env ?? process.env;
  const group = accountGroupFromHeaders(request.headers, env);
  const attempts = new Map<string, number>();
  let lastResponse: Response | undefined;
  let lastError: unknown;

  for (const _ of Array.from({ length: requestRetryLimit(env) })) {
    const account = selectAccount(pool, group, attempts, accountRetryLimit(env));
    if (!account) break;

    attempts.set(accountKey(account), (attempts.get(accountKey(account)) ?? 0) + 1);

    let token: string | undefined;
    try {
      token = await accountToken(pool, account);
    } catch (cause) {
      lastError = cause;
      continue;
    }
    if (!token) continue;

    const headers = grokResponsesHeaders(token, model, sessionIdFromHeaders(request.headers));
    if (payload.stream === true) headers.set('accept', 'text/event-stream');

    const response = await (options.fetch ?? fetch)(upstreamResponsesUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!shouldRetryWithAnotherAccount(response)) return { model, response };
    lastResponse = response;
  }

  if (lastResponse) return { model, response: lastResponse };
  if (lastError) throw lastError;

  throw new AnthropicApiError(
    401,
    'authentication_error',
    group
      ? `No Grok Build account is configured for group "${group}".`
      : 'GROK_BUILD_OAUTH_TOKEN, GROK_BUILD_ACCESS_TOKEN, GROK_BUILD_ACCOUNTS, or GROK_BUILD_ACCOUNTS_FILE is required.',
  );
}

function eventStreamResponse(body: ReadableStream<Uint8Array>) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

async function responseFromUpstream(
  request: Request,
  options: AnthropicApiHandlerOptions,
  payload: Record<string, unknown>,
  pool: GrokAccountPool,
  conversionOptions: ToolUseConversionOptions,
  stream: (
    body: ReadableStream<Uint8Array>,
    model: string,
    options: ToolUseConversionOptions,
  ) => ReadableStream<Uint8Array>,
  json: (body: unknown, model: string, options: ToolUseConversionOptions) => unknown,
) {
  const { model, response } = await fetchUpstreamResponses(request, options, payload, pool);

  if (!response.ok) return upstreamErrorResponse(response);
  if (payload.stream !== true) {
    return Response.json(json(await response.json(), model, conversionOptions));
  }
  if (!response.body) {
    return anthropicErrorResponse(502, 'Upstream Grok Build stream response had no body.');
  }
  return eventStreamResponse(stream(response.body, model, conversionOptions));
}

async function handleWebSearchMessages(
  request: Request,
  options: AnthropicApiHandlerOptions,
  body: unknown,
) {
  const env = options.env ?? process.env;
  const inputTokens = countAnthropicTokens(body).input_tokens;
  const pool = resolveAccountPool(env);

  if (pool.accounts.length > 0 && env.GROK_BUILD_WEB_SEARCH_PROVIDER !== 'external') {
    const payload = nativeWebSearchResponsesPayload(body, request.headers, options.cwd);
    const { response } = await fetchUpstreamResponses(request, options, payload, pool);
    if (response.ok) {
      return webSearchAnthropicResponseFromGrok(body, await response.json(), { inputTokens });
    }

    if (env.GROK_BUILD_WEB_SEARCH_PROVIDER === 'grok') return upstreamErrorResponse(response);
    await response.text();
  }

  return webSearchAnthropicResponse(body, {
    env,
    fetch: options.fetch,
    inputTokens,
  });
}

async function handleMessages(request: Request, options: AnthropicApiHandlerOptions) {
  const body = await requestJson(request);
  if (isWebSearchOnlyRequest(body)) {
    return handleWebSearchMessages(request, options, body);
  }

  const pool = resolveAccountPool(options.env ?? process.env);
  if (pool.accounts.length === 0) {
    return anthropicErrorResponse(
      401,
      'GROK_BUILD_OAUTH_TOKEN, GROK_BUILD_ACCESS_TOKEN, GROK_BUILD_ACCOUNTS, or GROK_BUILD_ACCOUNTS_FILE is required for /messages.',
      'authentication_error',
    );
  }

  const conversionOptions = { allowedToolNames: anthropicToolNamesFromRequest(body) };
  const payload = anthropicMessagesToResponsesPayload(body, request.headers, {
    cwd: options.cwd,
  });
  return responseFromUpstream(
    request,
    options,
    payload,
    pool,
    conversionOptions,
    responsesStreamToAnthropicSse,
    responsesJsonToAnthropicMessage,
  );
}

async function handleChatCompletions(request: Request, options: AnthropicApiHandlerOptions) {
  const pool = resolveAccountPool(options.env ?? process.env);
  if (pool.accounts.length === 0) {
    return anthropicErrorResponse(
      401,
      'GROK_BUILD_OAUTH_TOKEN, GROK_BUILD_ACCESS_TOKEN, GROK_BUILD_ACCOUNTS, or GROK_BUILD_ACCOUNTS_FILE is required for /chat/completions.',
      'authentication_error',
    );
  }

  const body = await requestJson(request);
  const conversionOptions = { allowedToolNames: openAIToolNamesFromRequest(body) };
  const payload = anthropicMessagesToResponsesPayload(
    openAIChatCompletionToAnthropicMessages(body),
    request.headers,
    { cwd: options.cwd },
  );
  return responseFromUpstream(
    request,
    options,
    payload,
    pool,
    conversionOptions,
    responsesStreamToOpenAIChatCompletionsSse,
    responsesJsonToOpenAIChatCompletion,
  );
}

export async function handleAnthropicApiRequest(
  request: Request,
  options: AnthropicApiHandlerOptions = {},
) {
  try {
    const pathname = normalizedPath(request);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (request.method === 'GET' && pathname === '/health') {
      return Response.json({ ok: true, type: 'open-grok-build-anthropic-api' });
    }

    if (request.method === 'GET' && pathname === '/auth/grok-build/login') {
      return loginPage();
    }

    const authError = clientAuthError(request, options.env ?? process.env);
    if (authError) return authError;

    if (request.method === 'GET' && pathname === '/auth/grok-build/accounts') {
      return accountPoolJson(options.env ?? process.env);
    }

    if (request.method === 'POST' && pathname === '/auth/grok-build/accounts') {
      return saveAdminAccount(request, options.env ?? process.env);
    }

    if (request.method === 'POST' && pathname === '/auth/grok-build/sessions') {
      return createLoginSession(request);
    }

    if (pathname.startsWith('/auth/grok-build/sessions/')) {
      return handleLoginSessionRoute(request, pathname);
    }

    if (request.method === 'GET' && pathname === '/v1/models') {
      return Response.json(anthropicModelsPayload());
    }

    if (request.method === 'POST' && routeIsCountTokens(pathname)) {
      return Response.json(countAnthropicTokens(await requestJson(request)));
    }

    if (request.method === 'POST' && routeIsMessages(pathname)) {
      return handleMessages(request, options);
    }

    if (request.method === 'POST' && routeIsChatCompletions(pathname)) {
      return handleChatCompletions(request, options);
    }

    return anthropicErrorResponse(404, `Route not found: ${request.method} ${pathname}.`);
  } catch (cause) {
    if (cause instanceof AnthropicApiError) {
      return anthropicErrorResponse(cause.status, cause.message, cause.type);
    }
    return anthropicErrorResponse(
      500,
      cause instanceof Error ? cause.message : 'Unexpected server error.',
    );
  }
}

function nodeRequestBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    req.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function nodeHeaders(req: IncomingMessage) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
      continue;
    }
    if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

async function webRequestFromNode(req: IncomingMessage, host: string, port: number) {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
  return new Request(url, {
    method,
    headers: nodeHeaders(req),
    body: method === 'GET' || method === 'HEAD' ? undefined : await nodeRequestBody(req),
  });
}

async function writeWebResponse(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    res.write(result.value);
  }
  res.end();
}

function serverListen(server: Server, host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

export async function startAnthropicApiServer(options: AnthropicApiServerOptions = {}) {
  const host = options.host ?? process.env.GROK_BUILD_API_HOST ?? '127.0.0.1';
  const port = options.port ?? Number.parseInt(process.env.GROK_BUILD_API_PORT || '8990', 10);

  const server = createServer(async (req, res) => {
    try {
      await writeWebResponse(
        res,
        await handleAnthropicApiRequest(await webRequestFromNode(req, host, port), options),
      );
    } catch (cause) {
      await writeWebResponse(
        res,
        anthropicErrorResponse(
          500,
          cause instanceof Error ? cause.message : 'Unexpected server error.',
        ),
      );
    }
  });

  await serverListen(server, host, port);
  return {
    server,
    host,
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
