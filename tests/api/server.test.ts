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

  it('posts sanitized Responses payloads upstream and converts non-streaming responses', async () => {
    process.env.GROK_BUILD_BASE_URL = 'https://proxy.example/v1/';
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe('https://proxy.example/v1/responses');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer upstream-token');
      expect(new Headers(init?.headers).get('x-grok-client-identifier')).toBe('grok-pager');
      expect(new Headers(init?.headers).get('x-grok-model-override')).toBe('grok-build');
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

  it('blocks unavailable streaming tool calls before they reach Claude Code', async () => {
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

    const response = await handleAnthropicApiRequest(
      jsonRequest('/cc/v1/messages', {
        model: 'grok-build',
        stream: true,
        messages: [{ role: 'user', content: 'Find files' }],
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

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('Skipped unavailable tool');
    expect(text).toContain('Use Bash with find');
    expect(text).not.toContain('"name":"Glob"');
    expect(text).not.toContain('"type":"tool_use"');
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

    const stream = await handleAnthropicApiRequest(
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
});
