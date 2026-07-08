import { spawn } from 'node:child_process';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { platform } from 'node:os';
import { beginGrokBuildOAuth } from '../auth/oauth.js';
import { payloadHasInputImage } from '../payload/sanitize.js';
import {
  accountFromOAuthCredentials,
  accountGroupFromHeaders,
  accountKey,
  accountRetryLimit,
  accountSummariesWithQuota,
  accountToken,
  exportAccountPoolJson,
  type GrokAccount,
  type GrokAccountPool,
  importAccountsToPoolFile,
  importGrokCliAuthToPoolFile,
  removeAccountFromPoolFile,
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
  DEFAULT_PROXY_API_KEY,
  grokResponsesHeaders,
  openAIChatCompletionToAnthropicMessages,
  openAIToolNamesFromRequest,
  resolveProxyApiKey,
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
    .quota { display: grid; gap: 8px; }
    .quota-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .quota-pct { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 18px; line-height: 1; letter-spacing: 0; }
    .quota-meta { font-size: 12px; color: color-mix(in srgb, CanvasText 68%, Canvas 32%); font-variant-numeric: tabular-nums; }
    .progress-track {
      width: 100%; height: 10px; border-radius: 6px; overflow: hidden;
      border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas 82%);
      background: color-mix(in srgb, CanvasText 8%, Canvas 92%);
    }
    .progress-fill {
      height: 100%; width: 0%; border-radius: 5px;
      background: CanvasText; min-width: 0;
    }
    .progress-fill.mid { background: color-mix(in srgb, CanvasText 72%, Canvas 28%); }
    .progress-fill.high { background: color-mix(in srgb, CanvasText 88%, #c44 12%); }
    .progress-fill.critical { background: color-mix(in srgb, CanvasText 40%, #c44 60%); }
    @media (max-width: 820px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Grok Build admin</h1>
        <p>One proxy API key for all clients. OAuth only adds upstream Grok accounts.</p>
      </div>
      <div class="actions">
        <button id="export-json" type="button" class="secondary">Export JSON</button>
        <button id="import-cli" type="button" class="secondary">Import grok login</button>
        <button id="refresh" type="button" class="secondary">Refresh accounts</button>
      </div>
    </header>
    <section>
      <h2>Proxy</h2>
      <p class="muted">Clients call this gateway with a single proxy API key (not your xAI token).</p>
      <label>Proxy API key
        <input id="api-key" name="apiKey" type="password" autocomplete="off" placeholder="local-client-key">
      </label>
      <div class="actions">
        <button id="show-key" type="button" class="secondary">Show / hide</button>
        <button id="copy-key" type="button" class="secondary">Copy key</button>
        <button id="copy-proxy" type="button" class="secondary">Copy client config</button>
      </div>
      <div id="proxy-meta" class="muted">Loading proxy settings...</div>
      <label>Client config
        <textarea id="proxy-config" readonly></textarea>
      </label>
    </section>
    <div class="grid">
      <section>
        <h2>Accounts</h2>
        <div id="pool-meta" class="muted">Enter the proxy API key to load accounts and quota.</div>
        <div id="accounts" class="records"></div>
        <div id="import-json-panel" class="hidden" style="display:grid;gap:14px">
          <h2>Import JSON</h2>
          <p class="muted">Paste an exported accounts file into the accounts pool.</p>
          <label>Accounts JSON
            <textarea id="import-json" placeholder='{"mode":"balanced","groups":[{"id":"default","accounts":[{"id":"...","access":"...","refresh":"..."}]}]}'></textarea>
          </label>
          <label>Import mode
            <select id="import-mode" style="width:100%;box-sizing:border-box;border:1px solid color-mix(in srgb, CanvasText 24%, Canvas 76%);border-radius:6px;padding:10px 11px;font:inherit;background:Canvas;color:CanvasText;">
              <option value="merge">Merge (update / add)</option>
              <option value="replace">Replace all</option>
            </select>
          </label>
          <div class="actions">
            <button id="import-json-btn" type="button">Import JSON</button>
            <label class="secondary" style="display:inline-flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid color-mix(in srgb, CanvasText 22%, Canvas 78%);border-radius:6px;font-weight:650;cursor:pointer;">
              Load file
              <input id="import-file" type="file" accept="application/json,.json" class="hidden">
            </label>
          </div>
        </div>
      </section>
      <section>
        <h2>Add account</h2>
        <form id="login-form">
          <label>Account group
            <input id="group" name="group" autocomplete="off" placeholder="default" value="default">
          </label>
          <div class="actions">
            <button id="oauth" type="button">OAuth</button>
            <button id="start" type="submit" class="secondary">Create login session</button>
            <button id="private" type="button" class="secondary" disabled>Open private login</button>
            <a id="normal" class="button secondary hidden" target="_blank" rel="noreferrer">Open login URL</a>
          </div>
          <p class="muted">OAuth creates a session and opens auth.x.ai in a new tab. Finish authorization, then save the account.</p>
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
    const KEY_STORAGE = 'grok-build-proxy-api-key';
    const form = document.querySelector('#login-form');
    const status = document.querySelector('#status');
    const poolMeta = document.querySelector('#pool-meta');
    const proxyMeta = document.querySelector('#proxy-meta');
    const proxyConfig = document.querySelector('#proxy-config');
    const accounts = document.querySelector('#accounts');
    const refreshButton = document.querySelector('#refresh');
    const exportJsonButton = document.querySelector('#export-json');
    const importCliButton = document.querySelector('#import-cli');
    const importJsonPanel = document.querySelector('#import-json-panel');
    const importJsonArea = document.querySelector('#import-json');
    const importModeSelect = document.querySelector('#import-mode');
    const importJsonButton = document.querySelector('#import-json-btn');
    const importFileInput = document.querySelector('#import-file');
    const oauthButton = document.querySelector('#oauth');
    const privateButton = document.querySelector('#private');
    const normalLink = document.querySelector('#normal');
    const result = document.querySelector('#result');
    const accountJson = document.querySelector('#account-json');
    const copyButton = document.querySelector('#copy');
    const saveButton = document.querySelector('#save');
    const apiKeyInput = document.querySelector('#api-key');
    const showKeyButton = document.querySelector('#show-key');
    const copyKeyButton = document.querySelector('#copy-key');
    const copyProxyButton = document.querySelector('#copy-proxy');
    const groupInput = document.querySelector('#group');
    let sessionId;
    let timer;
    let latestAccount;
    let canLogout = false;

    const proxyBaseUrl = () => new URL('/v1', window.location.origin).toString().replace(/\\/+$/, '');

    const headers = () => {
      const apiKey = apiKeyInput.value.trim();
      return apiKey
        ? { 'content-type': 'application/json', 'x-api-key': apiKey }
        : { 'content-type': 'application/json' };
    };

    const renderProxyConfig = () => {
      const apiKey = apiKeyInput.value.trim() || 'local-client-key';
      proxyConfig.value = JSON.stringify({
        baseURL: proxyBaseUrl(),
        apiKey
      }, null, 2);
    };

    const persistKey = () => {
      const value = apiKeyInput.value.trim();
      if (value) localStorage.setItem(KEY_STORAGE, value);
      else localStorage.removeItem(KEY_STORAGE);
      renderProxyConfig();
    };

    const escapeHtml = (value) => String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');

    const renderAccounts = (payload) => {
      const sourceLabel = payload.source === 'grok-cli'
        ? 'Grok CLI login (~/.grok/auth.json)'
        : payload.source === 'accounts-file'
          ? 'accounts file'
          : payload.source || 'none';
      poolMeta.textContent = payload.sourcePath
        ? 'Source: ' + sourceLabel + ' · ' + payload.sourcePath + ' · mode: ' + payload.mode
        : 'Source: ' + sourceLabel + ' · mode: ' + payload.mode;
      canLogout = !!payload.canLogout;
      importCliButton.disabled = !payload.canImportCli;
      exportJsonButton.disabled = !payload.canExportJson;
      if (payload.canImportJson) {
        importJsonPanel.classList.remove('hidden');
        importJsonPanel.style.display = 'grid';
        importJsonButton.disabled = false;
        importFileInput.disabled = false;
      } else {
        importJsonPanel.classList.add('hidden');
        importJsonPanel.style.display = 'none';
        importJsonButton.disabled = true;
        importFileInput.disabled = true;
      }
      accounts.innerHTML = '';
      if (!payload.accounts?.length) {
        accounts.innerHTML = '<div class="record muted">No accounts yet. Click <strong>OAuth</strong>, import <code>grok login</code>, or create a browser login session.</div>';
        return;
      }
      const quotaTone = (percent) => {
        if (percent >= 90) return 'critical';
        if (percent >= 75) return 'high';
        if (percent >= 50) return 'mid';
        return '';
      };

      const quotaBar = (bar, error) => {
        if (!bar) {
          return error
            ? '<div class="quota-meta">' + escapeHtml(error) + '</div>'
            : '';
        }
        const percent = Math.max(0, Math.min(100, Number(bar.percentUsed) || 0));
        const barWidth = Math.max(percent < 1 && percent > 0 ? 1 : 0, Math.min(100, percent));
        const tone = quotaTone(percent);
        const label = bar.label || (bar.period === 'weekly' ? 'Weekly SuperGrok Limit' : 'Monthly credits');
        const detail = bar.period === 'weekly'
          ? (bar.productUsage || []).map((p) => p.product + ' ' + p.usagePercent + '%').join(' · ') ||
            percent + '% of weekly SuperGrok pool'
          : (bar.used != null && bar.limit != null
              ? bar.used.toLocaleString() + ' / ' + bar.limit.toLocaleString() +
                ' credits · ' + (bar.remaining != null ? bar.remaining.toLocaleString() + ' left' : '')
              : percent + '% used');
        return (
          '<div class="quota" role="group" aria-label="' + escapeHtml(label) + '">' +
            '<div class="quota-head">' +
              '<span class="quota-pct">' + percent + '% <span class="quota-meta" style="font-weight:650;font-size:12px">used</span></span>' +
              '<span class="quota-meta">' + escapeHtml(label) + '</span>' +
            '</div>' +
            '<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + percent + '" aria-label="' + escapeHtml(label) + ' ' + percent + ' percent used">' +
              '<div class="progress-fill' + (tone ? ' ' + tone : '') + '" style="width:' + barWidth + '%"></div>' +
            '</div>' +
            '<div class="quota-meta">' + escapeHtml(detail) + '</div>' +
            '<div class="quota-meta">Resets ' + new Date(bar.billingPeriodEnd).toLocaleString() + '</div>' +
          '</div>'
        );
      };

      const quotaBlock = (account) => {
        if (!account.quota && !account.quotaError) {
          return '<div class="quota-meta">quota not checked</div>';
        }
        if (!account.quota) {
          return '<div class="quota-meta">quota unavailable: ' + escapeHtml(account.quotaError) + '</div>';
        }
        return (
          '<div style="display:grid;gap:12px">' +
            quotaBar(account.quota.weekly, account.quota.weeklyError ? 'weekly: ' + account.quota.weeklyError : '') +
            quotaBar(account.quota.monthly, account.quota.monthlyError ? 'monthly: ' + account.quota.monthlyError : '') +
          '</div>'
        );
      };

      for (const account of payload.accounts) {
        const record = document.createElement('div');
        record.className = 'record';
        const expires = account.expires ? new Date(account.expires).toLocaleString() : 'no expiry';
        record.innerHTML =
          '<div class="row"><h3>' + escapeHtml(account.id) + '</h3><span class="tag">' + escapeHtml(account.group) + '</span></div>' +
          '<div class="row muted"><span>priority ' + account.priority + '</span><span>' + expires + '</span></div>' +
          quotaBlock(account) +
          '<div class="row"><span class="tag">' + (account.hasAccess ? 'access' : 'no access') + '</span><span class="tag">' + (account.hasRefresh ? 'refresh' : 'no refresh') + '</span>' +
          (canLogout ? '<button type="button" class="secondary logout" data-id="' + escapeHtml(account.id) + '" data-group="' + escapeHtml(account.group) + '">Log out</button>' : '') +
          '</div>';
        accounts.appendChild(record);
      }
      for (const button of accounts.querySelectorAll('button.logout')) {
        button.addEventListener('click', async () => {
          status.textContent = 'Logging out account...';
          const response = await fetch('/auth/grok-build/accounts', {
            method: 'DELETE',
            headers: headers(),
            body: JSON.stringify({ id: button.dataset.id, group: button.dataset.group })
          });
          const body = await response.json();
          if (!response.ok) {
            status.textContent = body.error?.message || 'Could not log out account.';
            return;
          }
          status.textContent = 'Account logged out.';
          renderAccounts(body);
        });
      }
    };

    const loadAccounts = async () => {
      poolMeta.textContent = 'Loading accounts and quota...';
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
        status.textContent = 'OAuth complete. Credential received.';
        latestAccount = payload.account;
        accountJson.value = JSON.stringify(payload.account, null, 2);
        result.classList.remove('hidden');
        return;
      }
      status.textContent = payload.error || 'Login failed.';
    };

    const startLoginSession = async (openMode) => {
      clearInterval(timer);
      result.classList.add('hidden');
      latestAccount = undefined;
      oauthButton.disabled = true;
      status.textContent = 'Creating OAuth session...';
      const response = await fetch('/auth/grok-build/sessions', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ group: groupInput.value.trim() || 'default' })
      });
      const payload = await response.json();
      oauthButton.disabled = false;
      if (!response.ok) {
        status.textContent = payload.error?.message || 'Could not create OAuth session.';
        return;
      }
      sessionId = payload.id;
      normalLink.href = payload.url;
      normalLink.classList.remove('hidden');
      privateButton.disabled = false;
      timer = setInterval(poll, 1500);

      if (openMode === 'tab') {
        const opened = window.open(payload.url, '_blank', 'noopener,noreferrer');
        status.textContent = opened
          ? 'OAuth tab opened. Finish xAI authorization, then return here.'
          : 'Popup blocked. Use Open login URL, then finish xAI authorization.';
        return;
      }

      status.textContent = 'OAuth session ready. Open the login URL or private login, then finish xAI authorization.';
    };

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await startLoginSession('manual');
    });

    oauthButton.addEventListener('click', async () => {
      await startLoginSession('tab');
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

    importCliButton.addEventListener('click', async () => {
      status.textContent = 'Importing credentials from grok login...';
      const response = await fetch('/auth/grok-build/import-cli', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ group: groupInput.value.trim() || 'default' })
      });
      const payload = await response.json();
      if (!response.ok) {
        status.textContent = payload.error?.message || 'Could not import grok login.';
        return;
      }
      status.textContent = 'Imported grok login credentials.';
      renderAccounts(payload);
    });

    exportJsonButton.addEventListener('click', async () => {
      status.textContent = 'Exporting accounts JSON...';
      const response = await fetch('/auth/grok-build/accounts/export', { headers: headers() });
      const text = await response.text();
      if (!response.ok) {
        let message = 'Could not export accounts.';
        try { message = JSON.parse(text).error?.message || message; } catch {}
        status.textContent = message;
        return;
      }
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'grok-accounts.json';
      link.click();
      URL.revokeObjectURL(url);
      importJsonArea.value = text;
      status.textContent = 'Exported accounts JSON (download started).';
    });

    importFileInput.addEventListener('change', async () => {
      const file = importFileInput.files?.[0];
      if (!file) return;
      importJsonArea.value = await file.text();
      status.textContent = 'Loaded ' + file.name + '. Click Import JSON to apply.';
      importFileInput.value = '';
    });

    importJsonButton.addEventListener('click', async () => {
      let parsed;
      try {
        parsed = JSON.parse(importJsonArea.value);
      } catch {
        status.textContent = 'Import JSON is not valid JSON.';
        return;
      }
      status.textContent = 'Importing accounts JSON...';
      const response = await fetch('/auth/grok-build/accounts/import', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          importMode: importModeSelect.value === 'replace' ? 'replace' : 'merge',
          data: parsed
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        status.textContent = payload.error?.message || 'Could not import accounts JSON.';
        return;
      }
      status.textContent = 'Imported accounts JSON (' + importModeSelect.value + ').';
      renderAccounts(payload);
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

    showKeyButton.addEventListener('click', () => {
      apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
    });

    copyKeyButton.addEventListener('click', async () => {
      const value = apiKeyInput.value.trim();
      if (!value) {
        status.textContent = 'Enter the proxy API key first.';
        return;
      }
      await navigator.clipboard.writeText(value);
      status.textContent = 'Proxy API key copied.';
    });

    copyProxyButton.addEventListener('click', async () => {
      renderProxyConfig();
      await navigator.clipboard.writeText(proxyConfig.value);
      status.textContent = 'Client proxy config copied.';
    });

    refreshButton.addEventListener('click', loadAccounts);
    apiKeyInput.addEventListener('change', () => {
      persistKey();
      void loadAccounts();
    });
    apiKeyInput.addEventListener('input', persistKey);

    const savedKey = localStorage.getItem(KEY_STORAGE);
    apiKeyInput.value = savedKey || 'local-client-key';
    persistKey();
    void (async () => {
      const response = await fetch('/auth/grok-build/proxy');
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        proxyMeta.textContent = payload.usingDefaultKey
          ? 'Using default proxy API key: local-client-key (set GROK_BUILD_API_KEY to override).'
          : 'Custom proxy API key is configured on the server. Enter the same key here and for all clients.';
        if (payload.usingDefaultKey && payload.defaultApiKey && !savedKey) {
          apiKeyInput.value = payload.defaultApiKey;
          persistKey();
        }
      } else {
        proxyMeta.textContent = 'Could not load proxy settings.';
      }
      await loadAccounts();
    })();
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

async function accountPoolPayload(env: AnthropicApiEnvironment) {
  const pool = resolveAccountPool(env);
  return {
    mode: pool.mode,
    source: pool.source ?? null,
    sourcePath: pool.sourcePath ?? null,
    writable: pool.source === 'accounts-file' && !!pool.sourcePath,
    canImportCli: pool.source === 'accounts-file' && !!pool.sourcePath,
    canImportJson: pool.source === 'accounts-file' && !!pool.sourcePath,
    canExportJson: pool.accounts.length > 0,
    canLogout: pool.source === 'accounts-file' || pool.source === 'grok-cli',
    accounts: await accountSummariesWithQuota(pool),
  };
}

async function accountPoolJson(env: AnthropicApiEnvironment) {
  return Response.json(await accountPoolPayload(env));
}

function exportAccountsJson(env: AnthropicApiEnvironment) {
  const pool = resolveAccountPool(env);
  if (pool.accounts.length === 0) {
    throw new AnthropicApiError(404, 'invalid_request_error', 'No accounts to export.');
  }
  const payload = exportAccountPoolJson(pool);
  return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="grok-accounts-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}

async function importAccountsJson(request: Request, env: AnthropicApiEnvironment) {
  const body = await requestJson(request);
  if (!isRecord(body) && !Array.isArray(body)) {
    throw new AnthropicApiError(
      400,
      'invalid_request_error',
      'Import body must be JSON accounts or a pool object.',
    );
  }

  const importMode =
    isRecord(body) && body.importMode === 'replace' ? ('replace' as const) : ('merge' as const);
  const source =
    isRecord(body) && (isRecord(body.data) || Array.isArray(body.data)) ? body.data : body;

  try {
    importAccountsToPoolFile(env, source, { mode: importMode });
  } catch (cause) {
    throw new AnthropicApiError(
      400,
      'invalid_request_error',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  return Response.json(await accountPoolPayload(env));
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
  saveAccountToPoolFile(env, accountFromAdminPayload(await requestJson(request)));
  return Response.json(await accountPoolPayload(env));
}

async function removeAdminAccount(request: Request, env: AnthropicApiEnvironment) {
  const body = await requestJson(request);
  const payload = isRecord(body) && isRecord(body.account) ? body.account : body;
  if (!isRecord(payload) || !textField(payload.id)) {
    throw new AnthropicApiError(400, 'invalid_request_error', '`id` is required to log out.');
  }
  try {
    removeAccountFromPoolFile(env, {
      id: textField(payload.id) ?? '',
      group: textField(payload.group),
    });
  } catch (cause) {
    throw new AnthropicApiError(
      400,
      'invalid_request_error',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  return Response.json(await accountPoolPayload(env));
}

async function importCliAuthAccount(request: Request, env: AnthropicApiEnvironment) {
  const body = await requestJson(request);
  const group =
    isRecord(body) && typeof body.group === 'string' && body.group.trim()
      ? body.group.trim()
      : 'default';
  try {
    importGrokCliAuthToPoolFile(env, group);
  } catch (cause) {
    throw new AnthropicApiError(
      400,
      'invalid_request_error',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  return Response.json(await accountPoolPayload(env));
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

    const hasInputImage = payloadHasInputImage(payload);
    const headers = grokResponsesHeaders(
      token,
      model,
      hasInputImage ? undefined : sessionIdFromHeaders(request.headers),
    );
    if (payload.stream === true) headers.set('accept', 'text/event-stream');

    const response = await (options.fetch ?? fetch)(upstreamResponsesUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (hasInputImage && !response.ok) {
      const imageError = await unsupportedImageModelResponse(response);
      if (imageError?.unsupported) {
        const fallbackModel = imageFallbackModel(env);
        if (fallbackModel !== model) {
          const fallbackPayload: Record<string, unknown> = { ...payload, model: fallbackModel };
          const fallbackHeaders = grokResponsesHeaders(token, fallbackModel);
          if (fallbackPayload.stream === true) fallbackHeaders.set('accept', 'text/event-stream');
          const fallbackResponse = await (options.fetch ?? fetch)(upstreamResponsesUrl(), {
            method: 'POST',
            headers: fallbackHeaders,
            body: JSON.stringify(fallbackPayload),
          });
          return { model: fallbackModel, response: fallbackResponse };
        }
      }
      if (imageError) return { model, response: responseFromText(response, imageError.text) };
    }

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

function responseFromText(response: Response, text: string) {
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function imageFallbackModel(env: AnthropicApiEnvironment) {
  return env.GROK_BUILD_IMAGE_MODEL?.trim() || 'grok-build';
}

async function unsupportedImageModelResponse(response: Response) {
  if (response.status !== 400) return undefined;
  const text = await response.text();
  return {
    text,
    unsupported: /Image inputs are not supported by this model/i.test(text),
  };
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
      'No Grok credentials configured. Run `grok login`, set GROK_BUILD_ACCOUNTS_FILE, or open /auth/grok-build/login.',
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
      'No Grok credentials configured. Run `grok login`, set GROK_BUILD_ACCOUNTS_FILE, or open /auth/grok-build/login.',
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
      return Response.json({
        ok: true,
        type: 'open-grok-build-anthropic-api',
        proxy: {
          basePath: '/v1',
          auth: 'api_key',
          header: 'x-api-key or Authorization: Bearer',
        },
      });
    }

    if (request.method === 'GET' && pathname === '/auth/grok-build/login') {
      return loginPage();
    }

    if (request.method === 'GET' && pathname === '/auth/grok-build/proxy') {
      const env = options.env ?? process.env;
      const key = resolveProxyApiKey(env);
      return Response.json({
        basePath: '/v1',
        // Only reveal whether the default key is active — never echo custom secrets.
        apiKeyRequired: true,
        usingDefaultKey: key === DEFAULT_PROXY_API_KEY,
        defaultApiKey: key === DEFAULT_PROXY_API_KEY ? DEFAULT_PROXY_API_KEY : null,
        header: 'x-api-key',
        bearer: true,
      });
    }

    const authError = clientAuthError(request, options.env ?? process.env);
    if (authError) return authError;

    if (request.method === 'GET' && pathname === '/auth/grok-build/accounts') {
      return accountPoolJson(options.env ?? process.env);
    }

    if (request.method === 'POST' && pathname === '/auth/grok-build/accounts') {
      return saveAdminAccount(request, options.env ?? process.env);
    }

    if (request.method === 'DELETE' && pathname === '/auth/grok-build/accounts') {
      return removeAdminAccount(request, options.env ?? process.env);
    }

    if (request.method === 'POST' && pathname === '/auth/grok-build/import-cli') {
      return importCliAuthAccount(request, options.env ?? process.env);
    }

    if (request.method === 'GET' && pathname === '/auth/grok-build/accounts/export') {
      return exportAccountsJson(options.env ?? process.env);
    }

    if (request.method === 'POST' && pathname === '/auth/grok-build/accounts/import') {
      return importAccountsJson(request, options.env ?? process.env);
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
