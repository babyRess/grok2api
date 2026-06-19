import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAnthropicApiRequest } from '../../src/api/server.js';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(() => {
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function jsonRequest(path: string, body: unknown, headers?: HeadersInit) {
  return new Request(`http://127.0.0.1:8990${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

function imageMessageContent() {
  return [
    { type: 'text', text: 'What is this?' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aW1n' },
    },
  ];
}

function handleStreamingBashTool(content: string, fetchMock: typeof fetch) {
  return handleAnthropicApiRequest(
    jsonRequest('/cc/v1/messages', {
      model: 'grok-build',
      stream: true,
      messages: [{ role: 'user', content }],
      tools: [
        {
          name: 'Bash',
          input_schema: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
    }),
    {
      env: { GROK_BUILD_ACCESS_TOKEN: 'upstream-token' },
      fetch: fetchMock,
    },
  );
}

function handleStreamingOpenAIChat(fetchMock: typeof fetch) {
  return handleAnthropicApiRequest(
    jsonRequest('/v1/chat/completions', {
      model: 'grok-build',
      stream: true,
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    {
      env: { GROK_BUILD_OAUTH_TOKEN: 'upstream-token' },
      fetch: fetchMock,
    },
  );
}

describe('Anthropic API handler', () => {
  it('requires the configured client API key and accepts x-api-key', async () => {
    const blocked = await handleAnthropicApiRequest(new Request('http://local/v1/models'), {
      env: { GROK_BUILD_API_KEY: 'local-key' },
    });
    expect(blocked.status).toBe(401);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { type: 'authentication_error' },
    });

    const allowed = await handleAnthropicApiRequest(
      new Request('http://local/v1/models', { headers: { 'x-api-key': 'local-key' } }),
      { env: { GROK_BUILD_API_KEY: 'local-key' } },
    );
    expect(allowed.status).toBe(200);
  });

  it('accepts bearer client auth and allows local requests when no API key is configured', async () => {
    const bearer = await handleAnthropicApiRequest(
      new Request('http://local/v1/models', {
        headers: { authorization: 'Bearer local-key' },
      }),
      { env: { GROK_BUILD_API_KEY: 'local-key' } },
    );
    expect(bearer.status).toBe(200);

    const local = await handleAnthropicApiRequest(new Request('http://local/v1/models'), {
      env: {},
    });
    expect(local.status).toBe(200);
  });

  it('allows bearer client auth when x-api-key is present but does not match', async () => {
    const response = await handleAnthropicApiRequest(
      new Request('http://local/v1/models', {
        headers: { authorization: 'Bearer local-key', 'x-api-key': 'wrong-key' },
      }),
      { env: { GROK_BUILD_API_KEY: 'local-key' } },
    );

    expect(response.status).toBe(200);
  });

  it('serves models and count_tokens without an upstream token', async () => {
    const models = await handleAnthropicApiRequest(new Request('http://local/v1/models'), {
      env: {},
    });
    const modelsPayload = (await models.json()) as Record<string, unknown>;
    expect(modelsPayload.has_more).toBe(false);
    expect((modelsPayload.data as Record<string, unknown>[])[0]).toMatchObject({
      type: 'model',
      id: 'grok-composer-2.5-fast',
      max_tokens: 30_000,
      capabilities: null,
    });

    const count = await handleAnthropicApiRequest(
      jsonRequest('/cc/v1/messages/count_tokens', {
        system: 'Use short answers.',
        messages: [{ role: 'user', content: 'Hello there' }],
      }),
      { env: {} },
    );
    expect(count.status).toBe(200);
    await expect(count.json()).resolves.toMatchObject({ input_tokens: expect.any(Number) });
  });

  it('returns an Anthropic auth error when /messages has no upstream token', async () => {
    const response = await handleAnthropicApiRequest(
      jsonRequest('/v1/messages', {
        model: 'grok-build',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      { env: {} },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: expect.stringContaining('GROK_BUILD_OAUTH_TOKEN'),
      },
    });
  });

  it('serves Claude Code web_search-only requests without an upstream Grok token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe('https://search.example/api');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer search-key');
      expect(JSON.parse(String(init?.body))).toEqual({
        query: 'Claude Code WebSearch support',
        count: 5,
      });
      return Response.json({
        results: [
          {
            title: 'Claude Code docs',
            url: 'https://docs.example/claude-code',
            snippet: 'Claude Code can use server-side web search.',
          },
        ],
      });
    });

    const response = await handleAnthropicApiRequest(
      jsonRequest('/cc/v1/messages', {
        model: 'grok-build',
        stream: true,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Perform a web search for the query: Claude Code WebSearch support',
              },
            ],
          },
        ],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
      {
        env: {
          GROK_BUILD_WEB_SEARCH_ENDPOINT: 'https://search.example/api',
          GROK_BUILD_WEB_SEARCH_API_KEY: 'search-key',
        },
        fetch: fetchMock,
      },
    );

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('"type":"server_tool_use"');
    expect(text).toContain('"name":"web_search"');
    expect(text).toContain('"type":"web_search_tool_result"');
    expect(text).toContain('Claude Code docs');
    expect(text).toContain('https://docs.example/claude-code');
    expect(text).toContain('"server_tool_use":{"web_search_requests":1}');
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('prefers native Grok web_search when an upstream token is configured', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe('https://cli-chat-proxy.grok.com/v1/responses');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer upstream-token');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'grok-build',
        stream: false,
        tools: [{ type: 'web_search' }],
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Perform a web search for the query: xAI web search docs',
              },
            ],
          },
        ],
      });
      return Response.json({
        id: 'resp_search',
        model: 'grok-build',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Grok supports native web search.[[1]](https://docs.x.ai/developers/tools/web-search)',
                annotations: [
                  {
                    type: 'url_citation',
                    title: 'xAI Web Search',
                    url: 'https://docs.x.ai/developers/tools/web-search',
                    start_index: 33,
                    end_index: 93,
                  },
                ],
              },
            ],
          },
        ],
        citations: ['https://docs.x.ai/developers/tools/web-search'],
        usage: { input_tokens: 11, output_tokens: 8 },
      });
    });

    const response = await handleAnthropicApiRequest(
      jsonRequest('/cc/v1/messages', {
        model: 'grok-build',
        stream: true,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Perform a web search for the query: xAI web search docs',
              },
            ],
          },
        ],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
      {
        env: { GROK_BUILD_OAUTH_TOKEN: 'upstream-token' },
        fetch: fetchMock,
      },
    );

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"type":"server_tool_use"');
    expect(text).toContain('"type":"web_search_tool_result"');
    expect(text).toContain('Grok supports native web search');
    expect(text).toContain('https://docs.x.ai/developers/tools/web-search');
    expect(text).toContain('"input_tokens":11');
    expect(text).toContain('"output_tokens":8');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('serves WebSearch alias requests as non-streaming server search results', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        results: [
          {
            title: 'Search result',
            url: 'https://example.com/search-result',
            snippet: 'A custom endpoint result.',
          },
        ],
      }),
    );

    const response = await handleAnthropicApiRequest(
      jsonRequest('/v1/messages', {
        model: 'grok-build',
        stream: false,
        messages: [{ role: 'user', content: 'latest Grok Build docs' }],
        tools: [{ name: 'WebSearch' }],
      }),
      {
        env: { GROK_BUILD_WEB_SEARCH_ENDPOINT: 'https://search.example/api' },
        fetch: fetchMock,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text' },
        { type: 'server_tool_use', name: 'web_search' },
        {
          type: 'web_search_tool_result',
          content: [
            {
              type: 'web_search_result',
              title: 'Search result',
              url: 'https://example.com/search-result',
              encrypted_content: 'A custom endpoint result.',
            },
          ],
        },
        { type: 'text', text: expect.stringContaining('latest Grok Build docs') },
      ],
      stop_reason: 'end_turn',
      usage: { server_tool_use: { web_search_requests: 1 } },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('posts sanitized Responses payloads upstream and converts non-streaming responses', async () => {
    process.env.GROK_BUILD_BASE_URL = 'https://proxy.example/v1/';
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe('https://proxy.example/v1/responses');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer upstream-token');
      expect(new Headers(init?.headers).get('x-grok-client-identifier')).toBe('grok-pager');
      expect(new Headers(init?.headers).get('x-grok-model-override')).toBe('grok-build');
      expect(new Headers(init?.headers).get('x-grok-conv-id')).toBe('session-a');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'grok-build',
        max_output_tokens: 12,
        prompt_cache_key: 'session-a',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
      });
      return Response.json({
        id: 'resp_1',
        model: 'grok-build',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Hi' }],
          },
        ],
        usage: {
          input_tokens: 5,
          output_tokens: 1,
          input_tokens_details: { cached_tokens: 3 },
        },
      });
    });

    const response = await handleAnthropicApiRequest(
      jsonRequest(
        '/v1/messages',
        {
          model: 'grok-build',
          max_tokens: 12,
          messages: [{ role: 'user', content: 'Hello' }],
        },
        { 'x-session-id': 'session-a' },
      ),
      {
        env: { GROK_BUILD_OAUTH_TOKEN: 'upstream-token' },
        fetch: fetchMock,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'resp_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 3 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('disables upstream storage and conversation affinity for image requests', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('x-grok-conv-id')).toBeNull();
      expect(new Headers(init?.headers).get('x-grok-model-override')).toBe(
        'grok-composer-2.5-fast',
      );
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: 'grok-composer-2.5-fast',
        store: false,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'What is this?' },
              { type: 'input_image', image_url: 'data:image/png;base64,aW1n', detail: 'auto' },
            ],
          },
        ],
      });
      expect(body.metadata).toBeUndefined();
      expect(body.prompt_cache_key).toBeUndefined();
      return Response.json({
        id: 'resp_image',
        model: 'grok-composer-2.5-fast',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'An image.' }] }],
        usage: { input_tokens: 10, output_tokens: 3 },
      });
    });

    const response = await handleAnthropicApiRequest(
      jsonRequest(
        '/v1/messages',
        {
          model: 'composer-2.5-fast',
          metadata: { user_id: 'local-test' },
          messages: [
            {
              role: 'user',
              content: imageMessageContent(),
            },
          ],
        },
        { 'x-session-id': 'session-image' },
      ),
      {
        env: { GROK_BUILD_OAUTH_TOKEN: 'upstream-token' },
        fetch: fetchMock,
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries image requests with a vision fallback model when upstream rejects the model', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body));
      if (fetchMock.mock.calls.length === 1) {
        expect(headers.get('x-grok-model-override')).toBe('grok-composer-2.5-fast');
        expect(body.model).toBe('grok-composer-2.5-fast');
        return Response.json(
          {
            code: 'invalid-argument',
            error: 'Invalid request content: Image inputs are not supported by this model.',
          },
          { status: 400 },
        );
      }

      expect(headers.get('x-grok-conv-id')).toBeNull();
      expect(headers.get('x-grok-model-override')).toBe('grok-build');
      expect(body).toMatchObject({ model: 'grok-build', store: false });
      expect(body.prompt_cache_key).toBeUndefined();
      return Response.json({
        id: 'resp_image_fallback',
        model: 'grok-build',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Image ok.' }] }],
        usage: { input_tokens: 10, output_tokens: 3 },
      });
    });

    const response = await handleAnthropicApiRequest(
      jsonRequest(
        '/v1/messages',
        {
          model: 'composer-2.5-fast',
          messages: [{ role: 'user', content: imageMessageContent() }],
        },
        { 'x-session-id': 'session-image' },
      ),
      {
        env: { GROK_BUILD_OAUTH_TOKEN: 'upstream-token' },
        fetch: fetchMock,
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(response.json()).resolves.toMatchObject({
      model: 'grok-build',
      content: [{ type: 'text', text: 'Image ok.' }],
    });
  });

  it('rotates upstream tokens within the requested account group', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: 'resp_rotated',
        model: 'grok-build',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      }),
    );
    const env = {
      GROK_BUILD_ACCOUNTS: JSON.stringify({
        mode: 'balanced',
        groups: [
          {
            id: 'team',
            accounts: [
              { id: 'team-a', access: 'token-a' },
              { id: 'team-b', access: 'token-b' },
            ],
          },
        ],
      }),
    };

    await handleAnthropicApiRequest(
      jsonRequest(
        '/v1/messages',
        { model: 'grok-build', messages: [{ role: 'user', content: 'Hello' }] },
        { 'x-grok-account-group': 'team' },
      ),
      { env, fetch: fetchMock },
    );
    await handleAnthropicApiRequest(
      jsonRequest(
        '/v1/messages',
        { model: 'grok-build', messages: [{ role: 'user', content: 'Again' }] },
        { 'x-grok-account-group': 'team' },
      ),
      { env, fetch: fetchMock },
    );

    expect(
      fetchMock.mock.calls.map((call) => new Headers(call[1]?.headers).get('authorization')),
    ).toEqual(['Bearer token-a', 'Bearer token-b']);
  });

  it('retries a priority account before failing over to the next account', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
      new Headers(init?.headers).get('authorization') === 'Bearer token-a'
        ? new Response('rate limited', { status: 429 })
        : Response.json({
            id: 'resp_failover',
            model: 'grok-build',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
          }),
    );

    const response = await handleAnthropicApiRequest(
      jsonRequest('/v1/messages', {
        model: 'grok-build',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      {
        env: {
          GROK_BUILD_ACCOUNT_ROTATION: 'priority',
          GROK_BUILD_ACCOUNTS: JSON.stringify([
            { id: 'first', access: 'token-a', priority: 0 },
            { id: 'second', access: 'token-b', priority: 1 },
          ]),
        },
        fetch: fetchMock,
      },
    );

    expect(response.status).toBe(200);
    expect(
      fetchMock.mock.calls.map((call) => new Headers(call[1]?.headers).get('authorization')),
    ).toEqual(['Bearer token-a', 'Bearer token-a', 'Bearer token-a', 'Bearer token-b']);
  });

  it('serves the browser login page while protecting session actions with the API key', async () => {
    const login = await handleAnthropicApiRequest(
      new Request('http://local/auth/grok-build/login'),
      { env: { GROK_BUILD_API_KEY: 'local-key' } },
    );
    expect(login.status).toBe(200);
    await expect(login.text()).resolves.toContain('Grok Build admin');

    const blocked = await handleAnthropicApiRequest(
      new Request('http://local/auth/grok-build/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      { env: { GROK_BUILD_API_KEY: 'local-key' } },
    );
    expect(blocked.status).toBe(401);
  });

  it('lists and saves accounts through the admin API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-server-accounts-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'accounts.json'), '{"mode":"balanced","groups":[]}');
    const env = {
      GROK_BUILD_API_KEY: 'local-key',
      GROK_BUILD_ACCOUNTS_FILE: join(dir, 'accounts.json'),
    };

    const empty = await handleAnthropicApiRequest(
      new Request('http://local/auth/grok-build/accounts', {
        headers: { 'x-api-key': 'local-key' },
      }),
      { env },
    );
    await expect(empty.json()).resolves.toMatchObject({
      writable: true,
      accounts: [],
    });

    const saved = await handleAnthropicApiRequest(
      new Request('http://local/auth/grok-build/accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'local-key' },
        body: JSON.stringify({
          account: {
            id: 'admin-added',
            group: 'default',
            access: 'access-token',
            refresh: 'refresh-token',
          },
        }),
      }),
      { env },
    );

    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      accounts: [
        {
          id: 'admin-added',
          group: 'default',
          hasAccess: true,
          hasRefresh: true,
        },
      ],
    });
    expect(readFileSync(join(dir, 'accounts.json'), 'utf8')).toContain('admin-added');
  });

  it('converts streaming text and tool call Responses events to Anthropic SSE', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp_stream","model":"grok-build"}}\n\n',
        'event: ping\n',
        'data: {"type":"ping"}\n\n',
        'event: response.output_text.delta\n',
        'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
        'event: response.output_text.delta\n',
        'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
        'event: response.output_text.done\n',
        'data: {"type":"response.output_text.done"}\n\n',
        'event: response.output_item.added\n',
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup"}}\n\n',
        'event: response.function_call_arguments.delta\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"query\\""}\n\n',
        'event: response.function_call_arguments.delta\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":":\\"docs\\"}"}\n\n',
        'event: response.output_item.done\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup","arguments":"{\\"query\\":\\"docs\\"}"}}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp_stream","model":"grok-build","output":[{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"query\\":\\"docs\\"}"}],"usage":{"input_tokens":4,"output_tokens":2,"cache_creation_input_tokens":1}}}\n\n',
      ]),
    );

    const response = await handleAnthropicApiRequest(
      jsonRequest('/cc/v1/messages', {
        model: 'grok-build',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            name: 'lookup',
            input_schema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      }),
      {
        env: { GROK_BUILD_ACCESS_TOKEN: 'upstream-token' },
        fetch: fetchMock,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const text = await response.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: ping');
    expect(text).toContain('"type":"text_delta","text":"Hel"');
    expect(text).toContain('"type":"input_json_delta","partial_json":"{\\"query\\""');
    expect(text).toContain('"type":"input_json_delta","partial_json":":\\"docs\\"}"');
    expect(text).toContain('"stop_reason":"tool_use"');
    expect(text).toContain('"cache_creation_input_tokens":1');
    expect(text).toContain('event: message_stop');
  });

  it('surfaces incomplete Anthropic streams instead of ending the message normally', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp_stream","model":"grok-build"}}\n\n',
        'event: response.output_text.delta\n',
        'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
      ]),
    );

    const response = await handleAnthropicApiRequest(
      jsonRequest('/cc/v1/messages', {
        model: 'grok-build',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      {
        env: { GROK_BUILD_ACCESS_TOKEN: 'upstream-token' },
        fetch: fetchMock,
      },
    );

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"type":"text_delta","text":"Partial"');
    expect(text).toContain('event: error');
    expect(text).toContain('Upstream Responses stream ended before response.completed.');
    expect(text).not.toContain('event: message_stop');
    expect(text).not.toContain('"stop_reason":"end_turn"');
  });

  it('converts unavailable streaming Glob tool calls to Bash before they reach Claude Code', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp_stream","model":"grok-build"}}\n\n',
        'event: response.output_item.added\n',
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"Glob"}}\n\n',
        'event: response.function_call_arguments.delta\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"pattern\\":\\"**/*.ts\\"}"}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp_stream","model":"grok-build","output":[{"type":"function_call","call_id":"call_1","name":"Glob","arguments":"{\\"pattern\\":\\"**/*.ts\\"}"}],"usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
      ]),
    );

    const response = await handleStreamingBashTool('Find files', fetchMock);

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"name":"Bash"');
    expect(text).toContain("fd --hidden --glob '**/*.ts' .");
    expect(text).toContain('find . -path');
    expect(text).not.toContain('"name":"Glob"');
    expect(text).not.toContain('Skipped unavailable tool');
    expect(text).not.toContain('Available tools');
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it('drops unsupported streaming tool calls without fallback text', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp_stream","model":"grok-build"}}\n\n',
        'event: response.output_item.added\n',
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_2","call_id":"call_2","name":"Read"}}\n\n',
        'event: response.function_call_arguments.delta\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_2","delta":"{\\"file_path\\":\\"README.md\\"}"}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp_stream","model":"grok-build","output":[{"type":"function_call","call_id":"call_2","name":"Read","arguments":"{\\"file_path\\":\\"README.md\\"}"}],"usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
      ]),
    );

    const response = await handleStreamingBashTool('Read README', fetchMock);

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain('A requested tool is not available in this session');
    expect(text).not.toContain('Skipped unavailable tool');
    expect(text).not.toContain('Available tools');
    expect(text).not.toContain('"name":"Read"');
    expect(text).not.toContain('"type":"tool_use"');
    expect(text).toContain('event: message_stop');
    expect(text).toContain('"stop_reason":"end_turn"');
  });

  it('serves OpenAI-compatible chat completions', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'grok-composer-2.5-fast',
        max_output_tokens: 32,
        instructions: 'Use short answers.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
      });
      return Response.json({
        id: 'resp_chat',
        model: 'grok-composer-2.5-fast',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Hi there' }],
          },
        ],
        usage: {
          input_tokens: 9,
          output_tokens: 2,
          cache_read_input_tokens: 4,
        },
      });
    });

    const response = await handleAnthropicApiRequest(
      jsonRequest('/v1/chat/completions', {
        model: 'grok-composer-2.5-fast',
        max_tokens: 32,
        messages: [
          { role: 'system', content: 'Use short answers.' },
          { role: 'user', content: 'Hello' },
        ],
      }),
      {
        env: { GROK_BUILD_OAUTH_TOKEN: 'upstream-token' },
        fetch: fetchMock,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'resp_chat',
      object: 'chat.completion',
      model: 'grok-composer-2.5-fast',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hi there' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 2,
        total_tokens: 11,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    });
  });

  it('streams OpenAI-compatible chat completion chunks', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'data: {"type":"response.created","response":{"id":"resp_openai_stream","model":"grok-build"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_openai_stream","model":"grok-build","output":[{"type":"message","content":[{"type":"output_text","text":"Hello"}]}],"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
      ]),
    );

    const stream = await handleStreamingOpenAIChat(fetchMock);

    const events = (await stream.text()).split('\n\n').filter(Boolean);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"object":"chat.completion.chunk"'),
        expect.stringContaining('"delta":{"role":"assistant"}'),
        expect.stringContaining('"delta":{"content":"Hel"}'),
        expect.stringContaining('"finish_reason":"stop"'),
        expect.stringContaining(
          '"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}',
        ),
        'data: [DONE]',
      ]),
    );
  });

  it('surfaces incomplete OpenAI-compatible streams before DONE', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'data: {"type":"response.created","response":{"id":"resp_openai_stream","model":"grok-build"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
      ]),
    );

    const stream = await handleStreamingOpenAIChat(fetchMock);

    const text = await stream.text();
    expect(stream.status).toBe(200);
    expect(text).toContain('"delta":{"content":"Hel"}');
    expect(text).toContain('Upstream Responses stream ended before response.completed.');
    expect(text).toContain('data: [DONE]');
    expect(text).not.toContain('"finish_reason":"stop"');
  });
});
