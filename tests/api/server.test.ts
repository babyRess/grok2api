import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAnthropicApiRequest } from '../../src/api/server.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
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
});
