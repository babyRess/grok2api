import { describe, expect, it } from 'vitest';
import {
  anthropicMessagesToResponsesPayload,
  anthropicModelsPayload,
  countAnthropicTokens,
  responsesJsonToAnthropicMessage,
} from '../../src/api/anthropic.js';

describe('Anthropic adapter', () => {
  it('converts Anthropic messages, tools, images, and tool results to Responses payloads', () => {
    const headers = new Headers({ 'x-session-id': 'session-123' });
    const payload = anthropicMessagesToResponsesPayload(
      {
        model: 'grok-4.3',
        max_tokens: 123,
        system: [{ type: 'text', text: 'You are concise.' }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look at this.' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'aW1n' },
              },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will call a tool.' },
              { type: 'tool_use', id: 'call_1', name: 'lookup', input: { query: 'x' } },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                content: [
                  { type: 'text', text: 'tool text' },
                  {
                    type: 'image',
                    source: { type: 'url', url: 'https://example.invalid/image.png' },
                  },
                ],
              },
            ],
          },
        ],
        tools: [
          {
            name: 'lookup',
            description: 'Find data',
            input_schema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'lookup' },
        thinking: { type: 'enabled', budget_tokens: 4096 },
        temperature: 0.2,
        top_p: 0.9,
        stop_sequences: ['STOP'],
        metadata: { user_id: 'local-test' },
        stream: false,
      },
      headers,
    );

    expect(payload).toMatchObject({
      model: 'grok-4.3',
      max_output_tokens: 123,
      instructions: expect.stringContaining('You are concise.'),
      temperature: 0.2,
      top_p: 0.9,
      stop: ['STOP'],
      stream: false,
      tool_choice: { type: 'function', name: 'lookup' },
      store: false,
      reasoning: { effort: 'medium' },
    });
    expect(payload.metadata).toBeUndefined();
    expect(payload.prompt_cache_key).toBeUndefined();
    expect(payload.instructions).toEqual(
      expect.stringContaining('only call tools included in this request: lookup'),
    );
    expect(payload.tools).toEqual([
      {
        type: 'function',
        name: 'lookup',
        description: 'Find data',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ]);
    expect(payload.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Look at this.' },
          { type: 'input_image', image_url: 'data:image/png;base64,aW1n', detail: 'auto' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I will call a tool.' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"query":"x"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'tool text' },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'The previous tool result (call_1) included 1 image. Use the attached image as the visual output from that tool.',
          },
          {
            type: 'input_image',
            image_url: 'https://example.invalid/image.png',
            detail: 'auto',
          },
        ],
      },
    ]);
  });

  it('normalizes Composer aliases before sending upstream', () => {
    const payload = anthropicMessagesToResponsesPayload({
      model: 'composer-2.5-fast',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'aW1n' },
            },
          ],
        },
      ],
    });

    expect(payload).toMatchObject({
      model: 'grok-composer-2.5-fast',
      store: false,
    });
    expect(JSON.stringify(payload)).toContain('input_image');
  });

  it('returns Anthropic-native model list metadata', () => {
    const payload = anthropicModelsPayload();

    expect(payload.has_more).toBe(false);
    expect(payload.data[0]).toMatchObject({
      type: 'model',
      id: 'grok-composer-2.5-fast',
      display_name: 'Composer 2.5 Fast (Grok Build)',
      created_at: '2026-01-01T00:00:00Z',
      max_tokens: 30_000,
      max_input_tokens: 200_000,
      capabilities: null,
    });
  });

  it('estimates token counts deterministically from request text', () => {
    const request = {
      system: 'You are concise.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize this.' }] }],
      tools: [{ name: 'lookup', description: 'Find data' }],
    };

    expect(countAnthropicTokens(request)).toEqual(countAnthropicTokens(request));
    expect(countAnthropicTokens(request).input_tokens).toBeGreaterThan(0);
  });

  it('converts Responses JSON to Anthropic message JSON', () => {
    const message = responsesJsonToAnthropicMessage(
      {
        id: 'resp_1',
        model: 'grok-build',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello' }],
          },
          {
            type: 'function_call',
            call_id: 'call_2',
            name: 'search',
            arguments: '{"query":"docs"}',
          },
        ],
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
        },
      },
      'grok-build',
    );

    expect(message).toEqual({
      id: 'resp_1',
      type: 'message',
      role: 'assistant',
      model: 'grok-build',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'call_2', name: 'search', input: { query: 'docs' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 2,
      },
    });
  });

  it('converts unavailable Glob tool calls to Bash', () => {
    const message = responsesJsonToAnthropicMessage(
      {
        id: 'resp_1',
        model: 'grok-build',
        finish_reason: 'tool_calls',
        output: [
          {
            type: 'function_call',
            call_id: 'call_2',
            name: 'Glob',
            arguments: '{"pattern":"**/*.ts"}',
          },
        ],
      },
      'grok-build',
      { allowedToolNames: ['Bash'] },
    );

    expect(message.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_2',
        name: 'Bash',
        input: {
          command: expect.stringContaining("fd --hidden --glob '**/*.ts' ."),
        },
      },
    ]);
    expect(message.stop_reason).toBe('tool_use');
  });

  it('drops unavailable WebSearch calls without fallback text', () => {
    const message = responsesJsonToAnthropicMessage(
      {
        id: 'resp_2',
        model: 'grok-build',
        output: [
          {
            type: 'function_call',
            call_id: 'call_3',
            name: 'WebSearch',
            arguments: '{"query":"latest docs"}',
          },
        ],
      },
      'grok-build',
      { allowedToolNames: ['Bash'] },
    );

    expect(message.content).toEqual([]);
    expect(message.stop_reason).toBe('end_turn');
  });
});
