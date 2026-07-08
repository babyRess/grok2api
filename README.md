# open-grok-build

Anthropic-compatible local API gateway for xAI Grok Build models
(`cli-chat-proxy.grok.com`). It translates Anthropic and OpenAI-compatible
requests into Grok Build Responses API calls, sanitizes payload quirks, and can
rotate traffic across multiple Grok Build accounts.

## Features

- Anthropic-compatible endpoints for Claude-style clients
- OpenAI-compatible `POST /v1/chat/completions`
- Grok Build payload sanitization for reasoning, images, system messages, tools,
  response formats, and session cache keys
- Account groups with `balanced` round-robin or `priority` failover
- Per-account retry and per-request retry limits
- Grok CLI login (`grok login` / `~/.grok/auth.json`) for gateway auth
- Browser login helper page to create account JSON entries
- Admin logout and import-from-CLI-login actions
- Server-side Claude Code `web_search` / `WebSearch` handling
- Optional local client API key protection

## Quick Start

Install dependencies and start the local gateway:

```bash
bun install
bun run api
```

The server listens on `http://127.0.0.1:8990` by default. Override with
`GROK_BUILD_API_HOST` and `GROK_BUILD_API_PORT`.

## Authenticate (Grok CLI login)

The gateway reuses credentials from the official Grok CLI when no account pool
or static token is configured:

```bash
grok login
bun run api
```

Tokens are read from `~/.grok/auth.json` (override with `GROK_AUTH_FILE` or
`GROK_BUILD_CLI_AUTH_FILE`). Refreshed tokens are written back to that file.
Disable this fallback with `GROK_BUILD_DISABLE_CLI_AUTH=1`.

You can also import a CLI login into `GROK_BUILD_ACCOUNTS_FILE` from the admin
UI (**Import grok login**) or:

```bash
curl -s http://127.0.0.1:8990/auth/grok-build/import-cli \
  -H 'content-type: application/json' \
  -H 'x-api-key: local-client-key' \
  -d '{"group":"default"}'
```

Log out / remove an account:

```bash
curl -s -X DELETE http://127.0.0.1:8990/auth/grok-build/accounts \
  -H 'content-type: application/json' \
  -H 'x-api-key: local-client-key' \
  -d '{"id":"user@example.com","group":"default"}'
```

## Single Account

For a simple static upstream token:

```bash
export GROK_BUILD_OAUTH_TOKEN="xai-oauth-access-token"
export GROK_BUILD_API_KEY="local-client-key"
bun run api
```

Clients call the Anthropic base URL:

```json
{
  "provider": {
    "anthropic": {
      "options": {
        "baseURL": "http://127.0.0.1:8990/v1",
        "apiKey": "local-client-key"
      }
    }
  }
}
```

**One proxy API key** protects the gateway. Clients and the admin UI use the
same key via `x-api-key` or `Authorization: Bearer ...`. Default is
`local-client-key` when `GROK_BUILD_API_KEY` is unset.

## Account Groups

Use `GROK_BUILD_ACCOUNTS` for inline JSON, or `GROK_BUILD_ACCOUNTS_FILE` for a
JSON file. Account entries may use `access`, `accessToken`, `token`, `refresh`,
`refreshToken`, `expires`, `expiresAt`, `tokenEndpoint`, `priority`, and
`disabled`.

```json
{
  "mode": "balanced",
  "groups": [
    {
      "id": "personal",
      "accounts": [
        {
          "id": "personal-a",
          "access": "xai-access-token-a",
          "priority": 0
        },
        {
          "id": "personal-b",
          "access": "xai-access-token-b",
          "priority": 1
        }
      ]
    },
    {
      "id": "work",
      "tokens": ["xai-access-token-c", "xai-access-token-d"]
    }
  ]
}
```

Start with a file:

```bash
export GROK_BUILD_ACCOUNTS_FILE="$PWD/accounts.json"
bun run api
```

Pick a group per request with `x-grok-account-group`:

```bash
curl http://127.0.0.1:8990/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: local-client-key' \
  -H 'x-grok-account-group: personal' \
  -d '{
    "model": "grok-build",
    "max_tokens": 64,
    "messages": [{"role":"user","content":"hello"}]
  }'
```

If no group header is provided, `GROK_BUILD_ACCOUNT_GROUP` is used. If that is
also empty, all enabled accounts are eligible.

### Rotation Modes

`balanced` is the default for account pools and rotates eligible accounts in a
round-robin order.

`priority` retries lower-priority-number accounts first, then fails over to the
next account when retryable upstream failures continue.

Configure with either field:

```bash
export GROK_BUILD_ACCOUNT_ROTATION=balanced
export GROK_BUILD_LOAD_BALANCING_MODE=priority
```

Retry defaults:

- `GROK_BUILD_ACCOUNT_RETRIES=3`
- `GROK_BUILD_ACCOUNT_REQUEST_RETRIES=9`

## Login Helper

Open the local helper page after starting the server:

```text
http://127.0.0.1:8990/auth/grok-build/login
```

Create a login session, use the private-login button or copy the login URL into
an incognito/private window, finish xAI authorization, then press
`Save to account file` in the admin UI. The account is written to
`GROK_BUILD_ACCOUNTS_FILE`.

The private-login button attempts to launch Chrome Incognito on macOS and Linux.
If your browser blocks that or Chrome is unavailable, use the normal login URL
manually in a private window.

The admin page uses the same single proxy API key for all management calls.
Default key is `local-client-key` (override with `GROK_BUILD_API_KEY`).

## WebSearch

Claude Code can send Anthropic server-tool requests where the only tool is
`web_search`. The gateway handles those requests locally and returns Anthropic
`server_tool_use` plus `web_search_tool_result` blocks instead of forwarding
them as normal function tools.

By default, WebSearch uses the configured Grok Build account first because xAI's
Responses API supports native `web_search`. If no Grok account is configured, or
native search fails in `auto` mode, it falls back to DuckDuckGo's instant-answer
API with no API key. For better VPS reliability, configure either a custom JSON
search endpoint or Brave Search:

```bash
# Custom endpoint: POST JSON {"query":"...","count":5}; accepts results/items/web.results
export GROK_BUILD_WEB_SEARCH_ENDPOINT="https://search.example/api"
export GROK_BUILD_WEB_SEARCH_API_KEY="optional-key"

# Or Brave Search
export GROK_BUILD_BRAVE_SEARCH_API_KEY="brave-search-key"
```

Limit results with `GROK_BUILD_WEB_SEARCH_MAX_RESULTS` (default `5`, max `10`).
Set `GROK_BUILD_WEB_SEARCH_PROVIDER=grok` to require native Grok search, or
`GROK_BUILD_WEB_SEARCH_PROVIDER=external` to skip Grok and use external search.

### Headless VPS Login

For a VPS with no desktop browser, make the OAuth callback reachable from your
local browser:

```bash
export GROK_BUILD_CALLBACK_HOST=0.0.0.0
export GROK_BUILD_CALLBACK_PUBLIC_HOST="your-vps-domain.example"
export GROK_BUILD_CALLBACK_PUBLIC_PORT=56122
bun run api
```

Open firewall or reverse-proxy access for the callback port, then create a login
session from SSH:

```bash
curl -s http://127.0.0.1:8990/auth/grok-build/sessions \
  -H 'content-type: application/json' \
  -H 'x-api-key: local-client-key' \
  -d '{"group":"vps"}' | jq
```

Copy the returned `url`, open it in a private browser window on your local
machine, finish xAI authorization, then poll the session until it returns
`status: "success"`:

```bash
curl -s http://127.0.0.1:8990/auth/grok-build/sessions/<session-id> \
  -H 'x-api-key: local-client-key' | jq
```

If your callback is behind HTTPS or a reverse proxy, set the exact public
redirect URL:

```bash
export GROK_BUILD_CALLBACK_URL="https://your-vps-domain.example/callback"
```

## API Routes

| Route | Method | Description |
|---|---:|---|
| `/health` | GET | Health check |
| `/v1/models` | GET | Anthropic-style model list |
| `/v1/messages` | POST | Anthropic-compatible messages |
| `/v1/messages/count_tokens` | POST | Deterministic local token estimate |
| `/cc/v1/messages` | POST | Claude Code alias for messages |
| `/cc/v1/messages/count_tokens` | POST | Claude Code alias for token estimate |
| `/v1/chat/completions` | POST | OpenAI-compatible chat completions |
| `/auth/grok-build/login` | GET | Browser admin for account login and saving |
| `/auth/grok-build/accounts` | GET | List redacted account summaries with quota |
| `/auth/grok-build/accounts` | POST | Save an account into the account file |
| `/auth/grok-build/accounts` | DELETE | Log out / remove an account |
| `/auth/grok-build/accounts/export` | GET | Export full accounts JSON (includes tokens) |
| `/auth/grok-build/accounts/import` | POST | Import accounts JSON (`merge` or `replace`) |
| `/auth/grok-build/import-cli` | POST | Import credentials from `grok login` |
| `/auth/grok-build/sessions` | POST | Create an OAuth login session |
| `/auth/grok-build/sessions/<id>` | GET | Poll an OAuth login session |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GROK_BUILD_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | Upstream API base URL |
| `GROK_BUILD_MODELS` | catalog | Comma-separated model IDs to expose |
| `GROK_BUILD_IMAGE_MODEL` | `grok-build` | Fallback model when upstream rejects image input for the requested model |
| `GROK_BUILD_OAUTH_TOKEN` | none | Legacy single static upstream token |
| `GROK_BUILD_ACCESS_TOKEN` | none | Legacy single static upstream token alias |
| `GROK_AUTH_FILE` / `GROK_BUILD_CLI_AUTH_FILE` | `~/.grok/auth.json` | Grok CLI login credentials |
| `GROK_BUILD_DISABLE_CLI_AUTH` | unset | Set `1`/`true` to ignore Grok CLI auth |
| `GROK_BUILD_ACCOUNTS` | none | Inline account pool JSON |
| `GROK_BUILD_ACCOUNTS_FILE` | none | Account pool JSON file |
| `GROK_BUILD_ACCOUNT_GROUP` | none | Default account group |
| `GROK_BUILD_ACCOUNT_ROTATION` | `balanced` | `balanced` or `priority` |
| `GROK_BUILD_LOAD_BALANCING_MODE` | none | Alias for rotation mode |
| `GROK_BUILD_ACCOUNT_RETRIES` | `3` | Max attempts per account |
| `GROK_BUILD_ACCOUNT_REQUEST_RETRIES` | `9` | Max upstream attempts per request |
| `GROK_BUILD_API_KEY` | `local-client-key` | Single proxy API key for clients + admin UI |
| `GROK_BUILD_API_HOST` | `127.0.0.1` | Local API host |
| `GROK_BUILD_API_PORT` | `8990` | Local API port |
| `GROK_BUILD_OAUTH_CLIENT_ID` | built-in | OAuth client ID override |
| `GROK_BUILD_CALLBACK_HOST` | `127.0.0.1` | OAuth loopback callback host |
| `GROK_BUILD_CALLBACK_PORT` | `56122` | OAuth loopback callback port |
| `GROK_BUILD_CALLBACK_PUBLIC_HOST` | callback host | Public host used in OAuth redirect URL |
| `GROK_BUILD_CALLBACK_PUBLIC_PORT` | callback port | Public port used in OAuth redirect URL |
| `GROK_BUILD_CALLBACK_PROTOCOL` | `http` | Public redirect protocol |
| `GROK_BUILD_CALLBACK_URL` | none | Exact public OAuth redirect URL override |
| `GROK_BUILD_TOKEN_TIMEOUT_MS` | `30000` | OAuth token request timeout |
| `GROK_BUILD_WEB_SEARCH_PROVIDER` | `auto` | `auto`, `grok`, or `external` WebSearch provider mode |
| `GROK_BUILD_WEB_SEARCH_ENDPOINT` | none | Optional custom WebSearch JSON endpoint |
| `GROK_BUILD_WEB_SEARCH_API_KEY` | none | Optional API key for custom WebSearch endpoint |
| `GROK_BUILD_WEB_SEARCH_AUTH_HEADER` | `authorization` | Header used for the custom WebSearch key |
| `GROK_BUILD_WEB_SEARCH_MAX_RESULTS` | `5` | WebSearch result limit, from `1` to `10` |
| `GROK_BUILD_BRAVE_SEARCH_API_KEY` | none | Optional Brave Search API key |
| `GROK_BUILD_BRAVE_SEARCH_ENDPOINT` | Brave API | Optional Brave Search endpoint override |

## Models

| Model | Context | Max Output | Reasoning | Input |
|---|---:|---:|---|---|
| `grok-composer-2.5-fast` | 200K | 30K | - | text, image |
| `grok-build` | 512K | 30K | yes | text, image |
| `grok-4.3` | 1M | 30K | yes | text, image |
| `grok-4.20-0309-reasoning` | 2M | 30K | yes | text, image |
| `grok-4.20-0309-non-reasoning` | 2M | 30K | - | text, image |
| `grok-4.20-multi-agent-0309` | 2M | 30K | yes | text, image |

Override with `GROK_BUILD_MODELS` (comma-separated model IDs). Unknown IDs get
sensible defaults.

## Docker

```bash
cp .env.example .env
mkdir -p data
cat > data/accounts.json <<'EOF'
{
  "mode": "balanced",
  "groups": []
}
EOF
docker compose up --build
```

Clients should use `http://127.0.0.1:8990/v1` as the Anthropic-compatible base
URL.

For a Docker VPS, edit `.env` like this:

```bash
GROK_BUILD_API_HOST=0.0.0.0
GROK_BUILD_API_PORT=8990
GROK_BUILD_API_KEY=local-client-key

GROK_BUILD_ACCOUNTS_FILE=/data/accounts.json
GROK_BUILD_ACCOUNT_ROTATION=balanced

GROK_BUILD_CALLBACK_HOST=0.0.0.0
GROK_BUILD_CALLBACK_PORT=56122
GROK_BUILD_CALLBACK_PUBLIC_HOST=your-vps-domain-or-ip
GROK_BUILD_CALLBACK_PUBLIC_PORT=56122
GROK_BUILD_CALLBACK_PROTOCOL=http
```

Then run:

```bash
docker compose up -d --build
docker compose logs -f open-grok-build
```

Create a headless login session from SSH:

```bash
curl -s http://127.0.0.1:8990/auth/grok-build/sessions \
  -H 'content-type: application/json' \
  -H 'x-api-key: local-client-key' \
  -d '{"group":"default"}' | jq
```

Open the returned `url` in a private browser window on your local machine, then
poll for the generated account JSON:

```bash
curl -s http://127.0.0.1:8990/auth/grok-build/sessions/<session-id> \
  -H 'x-api-key: local-client-key' | jq
```

You can also open the admin UI and save the account directly:

```text
http://YOUR_VPS_IP_OR_DOMAIN:8990/auth/grok-build/login
```

If you use the headless curl flow instead, append the returned `account` object
into `data/accounts.json` under the group you want, then restart:

```bash
docker compose restart open-grok-build
```

## Bruno (API tests)

Open the `bruno/` collection in [Bruno](https://www.usebruno.com/) and select the
`local` environment (`baseUrl=http://127.0.0.1:8990`, `apiKey=local-client-key`).

Included requests:

- Health / proxy meta
- List models
- Accounts + quota
- Anthropic messages (json + stream)
- OpenAI chat completions
- Count tokens

## Benchmark (tokens/s)

With the proxy running:

```bash
bun run api
bun run bench
```

Options:

```bash
bun scripts/benchmark-tokens.ts --runs 5 --model grok-build --max-tokens 512
```

Stream tok/s is measured from first content token to stream end. JSON tok/s is
end-to-end wall time (includes queue + reasoning).

## Development

```bash
bun install
bun run check
```

`bun run check` runs formatting/linting, typecheck, production dependency
checks, duplicate detection, and coverage.
