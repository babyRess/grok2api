import { getBaseUrl } from '../auth/oauth.js';
import { resolveModels } from '../models/catalog.js';
import { sanitizePayload } from '../payload/sanitize.js';

const GROK_BUILD_VERSION = '0.2.22';
const USER_AGENT = `grok-pager/${GROK_BUILD_VERSION} grok-shell/${GROK_BUILD_VERSION} (macos; aarch64)`;
const SESSION_HEADER_NAMES = ['x-grok-conv-id', 'anthropic-session-id', 'x-session-id'];
const MODEL_CATALOG_CREATED_AT = '2026-01-01T00:00:00Z';

type JsonRecord = Record<string, unknown>;
type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'rate_limit_error'
  | 'api_error';

export type AnthropicApiEnvironment = Record<string, string | undefined>;

export type AnthropicAdapterOptions = {
  cwd?: string;
};

export class AnthropicApiError extends Error {
  status: number;
  type: AnthropicErrorType;

  constructor(status: number, type: AnthropicErrorType, message: string) {
    super(message);
    this.name = 'AnthropicApiError';
    this.status = status;
    this.type = type;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseJsonRecord(value: string): JsonRecord {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function anthropicErrorTypeForStatus(status: number): AnthropicErrorType {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 400 && status < 500) return 'invalid_request_error';
  return 'api_error';
}

export function anthropicErrorResponse(
  status: number,
  message: string,
  type = anthropicErrorTypeForStatus(status),
) {
  return Response.json(
    {
      type: 'error',
      error: {
        type,
        message,
      },
    },
    { status },
  );
}

export function clientAuthError(request: Request, env = process.env): Response | undefined {
  const expected = env.GROK_BUILD_API_KEY;
  if (!expected) return undefined;

  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if ([request.headers.get('x-api-key'), bearer].some((provided) => provided === expected)) {
    return undefined;
  }

  return anthropicErrorResponse(401, 'Invalid or missing API key.', 'authentication_error');
}

export function upstreamToken(env = process.env): string | undefined {
  return env.GROK_BUILD_OAUTH_TOKEN || env.GROK_BUILD_ACCESS_TOKEN;
}

export function sessionIdFromHeaders(headers: Headers): string | undefined {
  return SESSION_HEADER_NAMES.map((name) => headers.get(name)?.trim()).find(Boolean);
}

export function anthropicModelsPayload() {
  const models = resolveModels();
  return {
    data: models.map((model) => ({
      type: 'model',
      id: model.id,
      display_name: model.name,
      created_at: MODEL_CATALOG_CREATED_AT,
      max_tokens: model.maxTokens,
      max_input_tokens: model.contextWindow,
      capabilities: null,
    })),
    has_more: false,
    first_id: models[0]?.id ?? null,
    last_id: models.at(-1)?.id ?? null,
  };
}

function textFromAnthropicText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  if (value.type === 'text' && typeof value.text === 'string') return value.text;
  return undefined;
}

function instructionsFromSystem(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;

  const instructions = value
    .map(textFromAnthropicText)
    .filter((part): part is string => !!part?.trim())
    .map((part) => part.trim())
    .join('\n\n');
  return instructions || undefined;
}

function contentBlocks(value: unknown): unknown[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return [];
}

function textPartType(role: string) {
  return role === 'assistant' ? 'output_text' : 'input_text';
}

function inputImageUrl(block: JsonRecord): string | undefined {
  if (!isRecord(block.source)) return undefined;
  if (block.source.type === 'base64') {
    const mediaType = optionalString(block.source.media_type) ?? 'image/png';
    const data = optionalString(block.source.data);
    return data ? `data:${mediaType};base64,${data}` : undefined;
  }
  if (block.source.type === 'url') return optionalString(block.source.url);
  return optionalString(block.source.url);
}

function responseContentPart(block: unknown, role: string): JsonRecord | undefined {
  if (typeof block === 'string') {
    return { type: textPartType(role), text: block };
  }
  if (!isRecord(block)) return undefined;

  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: textPartType(role), text: block.text };
  }

  if (block.type === 'image') {
    const imageUrl = inputImageUrl(block);
    return imageUrl ? { type: 'input_image', image_url: imageUrl, detail: 'auto' } : undefined;
  }

  return undefined;
}

function toolResultOutput(block: JsonRecord): string | JsonRecord[] {
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return '';

  const output = block.content
    .map((part) => responseContentPart(part, 'user'))
    .filter((part): part is JsonRecord => !!part);
  return output.length > 0 ? output : '';
}

function flushMessageContent(input: JsonRecord[], role: string, content: JsonRecord[]) {
  if (content.length === 0) return;
  input.push({
    role: role === 'assistant' ? 'assistant' : 'user',
    content: [...content],
  });
  content.length = 0;
}

function responsesInputFromMessages(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) {
    throw new AnthropicApiError(400, 'invalid_request_error', '`messages` must be an array.');
  }

  const input: JsonRecord[] = [];

  for (const message of value) {
    if (!isRecord(message)) continue;
    const role = optionalString(message.role) ?? 'user';
    const pendingContent: JsonRecord[] = [];

    for (const block of contentBlocks(message.content)) {
      if (isRecord(block) && block.type === 'tool_result') {
        flushMessageContent(input, role, pendingContent);
        input.push({
          type: 'function_call_output',
          call_id: optionalString(block.tool_use_id) ?? 'tool_result_unknown',
          output: toolResultOutput(block),
        });
        continue;
      }

      if (isRecord(block) && block.type === 'tool_use') {
        flushMessageContent(input, role, pendingContent);
        input.push({
          type: 'function_call',
          call_id: optionalString(block.id) ?? 'tool_use_unknown',
          name: optionalString(block.name) ?? 'tool',
          arguments: JSON.stringify(block.input ?? {}),
        });
        continue;
      }

      const part = responseContentPart(block, role);
      if (part) pendingContent.push(part);
    }

    flushMessageContent(input, role, pendingContent);
  }

  return input;
}

function responsesTools(value: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const tools = value.flatMap((tool): JsonRecord[] => {
    if (!isRecord(tool) || typeof tool.name !== 'string') return [];
    return [
      {
        type: 'function',
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: isRecord(tool.input_schema)
          ? tool.input_schema
          : { type: 'object', properties: {} },
      },
    ];
  });

  return tools.length > 0 ? tools : undefined;
}

function responsesToolChoice(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value === 'any') return 'required';
    if (value === 'auto' || value === 'none') return value;
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.type === 'any') return 'required';
  if (value.type === 'auto' || value.type === 'none') return value.type;
  if (value.type === 'tool' && typeof value.name === 'string') {
    return { type: 'function', name: value.name };
  }
  return undefined;
}

function responsesReasoning(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'disabled') return { effort: 'minimal' };
  if (value.type !== 'enabled') return undefined;

  const budget = optionalNumber(value.budget_tokens) ?? 0;
  return {
    effort: budget > 8192 ? 'high' : budget > 2048 ? 'medium' : 'low',
  };
}

export function anthropicMessagesToResponsesPayload(
  body: unknown,
  headers = new Headers(),
  options: AnthropicAdapterOptions = {},
) {
  if (!isRecord(body)) {
    throw new AnthropicApiError(
      400,
      'invalid_request_error',
      'Request body must be a JSON object.',
    );
  }

  const model = optionalString(body.model);
  if (!model) throw new AnthropicApiError(400, 'invalid_request_error', '`model` is required.');

  const payload: JsonRecord = {
    model,
    input: responsesInputFromMessages(body.messages),
  };

  const instructions = instructionsFromSystem(body.system);
  if (instructions) payload.instructions = instructions;
  if (optionalNumber(body.max_tokens) !== undefined) payload.max_output_tokens = body.max_tokens;
  if (optionalNumber(body.temperature) !== undefined) payload.temperature = body.temperature;
  if (optionalNumber(body.top_p) !== undefined) payload.top_p = body.top_p;
  if (typeof body.stream === 'boolean') payload.stream = body.stream;
  if (Array.isArray(body.stop_sequences)) payload.stop = body.stop_sequences;
  if (isRecord(body.metadata)) payload.metadata = body.metadata;

  const tools = responsesTools(body.tools);
  if (tools) payload.tools = tools;

  const toolChoice = responsesToolChoice(body.tool_choice);
  if (toolChoice) payload.tool_choice = toolChoice;

  const reasoning = responsesReasoning(body.thinking);
  if (reasoning) payload.reasoning = reasoning;

  return sanitizePayload(
    payload,
    model,
    sessionIdFromHeaders(headers),
    options.cwd ?? process.cwd(),
  );
}

function jsonStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(jsonStrings);
  if (!isRecord(value)) return [];
  if (
    value.type === 'image' &&
    isRecord(value.source) &&
    value.source.type === 'base64' &&
    typeof value.source.data === 'string'
  ) {
    return Object.entries(value)
      .filter(([key]) => key !== 'source')
      .flatMap((entry) => jsonStrings(entry[1]));
  }
  return Object.values(value).flatMap(jsonStrings);
}

function estimateTokens(text: string): number {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function countAnthropicTokens(body: unknown) {
  if (!isRecord(body)) return { input_tokens: 0 };

  const text = [
    ...jsonStrings(body.system),
    ...jsonStrings(body.messages),
    ...jsonStrings(body.tools),
  ].join('\n');

  return { input_tokens: estimateTokens(text) };
}

function outputTextContent(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  if (
    (part.type === 'output_text' || part.type === 'text' || part.type === 'input_text') &&
    typeof part.text === 'string'
  ) {
    return part.text;
  }
  return undefined;
}

function parsedToolInput(value: unknown): JsonRecord {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return {};
  return parseJsonRecord(value);
}

function contentFromOutputItem(item: unknown): JsonRecord[] {
  if (!isRecord(item)) return [];

  if (item.type === 'message' && Array.isArray(item.content)) {
    return item.content
      .map(outputTextContent)
      .filter((text): text is string => text !== undefined)
      .map((text) => ({ text, type: 'text' }));
  }

  if (item.type === 'function_call') {
    return [
      {
        type: 'tool_use',
        id: optionalString(item.call_id) ?? optionalString(item.id) ?? 'tool_use_unknown',
        name: optionalString(item.name) ?? 'tool',
        input: parsedToolInput(item.arguments),
      },
    ];
  }

  const text = outputTextContent(item);
  return text === undefined ? [] : [{ text, type: 'text' }];
}

function usageFromResponses(value: unknown) {
  const usage = isRecord(value) ? value : {};
  const inputTokensDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const promptTokensDetails = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : {};
  const cacheReadInputTokens =
    optionalNumber(usage.cache_read_input_tokens) ??
    optionalNumber(inputTokensDetails.cache_read_input_tokens) ??
    optionalNumber(inputTokensDetails.cached_tokens) ??
    optionalNumber(promptTokensDetails.cache_read_input_tokens) ??
    optionalNumber(promptTokensDetails.cached_tokens);
  const cacheCreationInputTokens =
    optionalNumber(usage.cache_creation_input_tokens) ??
    optionalNumber(inputTokensDetails.cache_creation_input_tokens) ??
    optionalNumber(promptTokensDetails.cache_creation_input_tokens);

  return {
    input_tokens: optionalNumber(usage.input_tokens) ?? optionalNumber(usage.prompt_tokens) ?? 0,
    output_tokens:
      optionalNumber(usage.output_tokens) ?? optionalNumber(usage.completion_tokens) ?? 0,
    ...(cacheReadInputTokens !== undefined
      ? { cache_read_input_tokens: cacheReadInputTokens }
      : {}),
    ...(cacheCreationInputTokens !== undefined
      ? { cache_creation_input_tokens: cacheCreationInputTokens }
      : {}),
  };
}

function stopReasonFromResponses(response: JsonRecord, hasToolUse: boolean) {
  if (hasToolUse) return 'tool_use';
  if (response.status === 'incomplete') return 'max_tokens';
  if (isRecord(response.incomplete_details) && response.incomplete_details.reason) {
    return 'max_tokens';
  }

  const reason = optionalString(response.stop_reason) ?? optionalString(response.finish_reason);
  if (reason === 'max_tokens' || reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls' || reason === 'tool_use') return 'tool_use';
  if (reason === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}

export function responsesJsonToAnthropicMessage(value: unknown, requestedModel?: string) {
  const response = isRecord(value) ? value : {};
  const content = Array.isArray(response.output)
    ? response.output.flatMap(contentFromOutputItem)
    : [];

  if (content.length === 0 && typeof response.output_text === 'string') {
    content.push({ type: 'text', text: response.output_text });
  }

  const hasToolUse = content.some((part) => part.type === 'tool_use');

  return {
    content,
    id: optionalString(response.id) ?? `msg_${crypto.randomUUID()}`,
    model: optionalString(response.model) ?? requestedModel ?? '',
    role: 'assistant',
    stop_reason: stopReasonFromResponses(response, hasToolUse),
    stop_sequence: null,
    type: 'message',
    usage: usageFromResponses(response.usage),
  };
}

function sse(event: string, data: JsonRecord) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function frameBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return undefined;
  if (lf === -1) return { index: crlf, length: 4 };
  if (crlf === -1 || lf < crlf) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

function parseSseFrame(frame: string): { event: string; data?: unknown } | undefined {
  const dataLines: string[] = [];
  let event = 'message';

  for (const rawLine of frame.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const separator = rawLine.indexOf(':');
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    const rawValue = separator === -1 ? '' : rawLine.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'event') event = value;
    if (field === 'data') dataLines.push(value);
  }

  const dataText = dataLines.join('\n');
  if (!dataText || dataText === '[DONE]') return { event };
  return { event, data: safeJson(dataText) };
}

async function* upstreamSseEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const result = await reader.read();
    if (result.done) break;

    buffer += decoder.decode(result.value, { stream: true });

    let boundary = frameBoundary(buffer);
    while (boundary) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const parsed = parseSseFrame(frame);
      if (parsed) yield parsed;
      boundary = frameBoundary(buffer);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseSseFrame(buffer);
    if (parsed) yield parsed;
  }
}

type StreamState = {
  contentIndex: number;
  messageId: string;
  messageStarted: boolean;
  messageStopped: boolean;
  model: string;
  openBlocks: Set<number>;
  textBlockIndex?: number;
  toolBlocks: Map<string, { index: number; argumentsEmitted: boolean }>;
};

function enqueueEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: string,
  data: JsonRecord,
) {
  controller.enqueue(new TextEncoder().encode(sse(event, data)));
}

function ensureMessageStart(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: StreamState,
) {
  if (state.messageStarted) return;
  state.messageStarted = true;
  enqueueEvent(controller, 'message_start', {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      model: state.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  });
}

function startTextBlock(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: StreamState,
) {
  ensureMessageStart(controller, state);
  if (state.textBlockIndex !== undefined && state.openBlocks.has(state.textBlockIndex)) {
    return state.textBlockIndex;
  }

  const index = state.contentIndex;
  state.contentIndex += 1;
  state.textBlockIndex = index;
  state.openBlocks.add(index);
  enqueueEvent(controller, 'content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '' },
  });
  return index;
}

function startToolBlock(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: StreamState,
  key: string,
  item?: JsonRecord,
) {
  ensureMessageStart(controller, state);
  const existing = state.toolBlocks.get(key);
  if (existing && state.openBlocks.has(existing.index)) return existing;

  const index = state.contentIndex;
  state.contentIndex += 1;
  const block = { index, argumentsEmitted: false };
  state.toolBlocks.set(key, block);
  state.openBlocks.add(index);
  enqueueEvent(controller, 'content_block_start', {
    type: 'content_block_start',
    index,
    content_block: {
      type: 'tool_use',
      id:
        optionalString(item?.call_id) ??
        optionalString(item?.id) ??
        optionalString(item?.item_id) ??
        key,
      name: optionalString(item?.name) ?? 'tool',
      input: {},
    },
  });
  return block;
}

function stopBlock(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: StreamState,
  index: number,
) {
  if (!state.openBlocks.has(index)) return;
  state.openBlocks.delete(index);
  enqueueEvent(controller, 'content_block_stop', {
    type: 'content_block_stop',
    index,
  });
}

function streamToolKey(event: JsonRecord) {
  return (
    optionalString(event.item_id) ??
    optionalString(event.output_item_id) ??
    optionalString(event.id) ??
    optionalString(event.call_id) ??
    String(optionalNumber(event.output_index) ?? 0)
  );
}

function eventType(eventName: string, data: unknown) {
  return (isRecord(data) && optionalString(data.type)) || eventName;
}

function responseRecordFromEvent(data: unknown): JsonRecord {
  if (!isRecord(data)) return {};
  if (isRecord(data.response)) return data.response;
  return data;
}

function emitFinalContentFromCompleted(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: StreamState,
  response: JsonRecord,
) {
  if (state.contentIndex > 0) return;
  const message = responsesJsonToAnthropicMessage(response, state.model);

  for (const block of message.content) {
    ensureMessageStart(controller, state);
    const index = state.contentIndex;
    state.contentIndex += 1;
    if (block.type === 'tool_use') {
      enqueueEvent(controller, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      });
      enqueueEvent(controller, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input ?? {}),
        },
      });
    } else {
      enqueueEvent(controller, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      enqueueEvent(controller, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: optionalString(block.text) ?? '' },
      });
    }
    enqueueEvent(controller, 'content_block_stop', {
      type: 'content_block_stop',
      index,
    });
  }
}

function completeMessage(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: StreamState,
  response: JsonRecord,
) {
  if (state.messageStopped) return;
  ensureMessageStart(controller, state);
  emitFinalContentFromCompleted(controller, state, response);

  for (const index of [...state.openBlocks]) stopBlock(controller, state, index);

  const message = responsesJsonToAnthropicMessage(response, state.model);
  enqueueEvent(controller, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: null,
    },
    usage: message.usage,
  });
  enqueueEvent(controller, 'message_stop', { type: 'message_stop' });
  state.messageStopped = true;
}

function handleStreamEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: StreamState,
  eventName: string,
  data: unknown,
) {
  const type = eventType(eventName, data);
  const event = isRecord(data) ? data : {};

  if (type === 'response.created') {
    const response = responseRecordFromEvent(event);
    state.messageId = optionalString(response.id) ?? state.messageId;
    state.model = optionalString(response.model) ?? state.model;
    ensureMessageStart(controller, state);
    return;
  }

  if (type === 'ping') {
    enqueueEvent(controller, 'ping', { type: 'ping' });
    return;
  }

  if (type === 'response.output_text.delta') {
    const text = optionalString(event.delta) ?? optionalString(event.text) ?? '';
    const index = startTextBlock(controller, state);
    enqueueEvent(controller, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    });
    return;
  }

  if (type === 'response.output_text.done') {
    if (state.textBlockIndex !== undefined) stopBlock(controller, state, state.textBlockIndex);
    return;
  }

  if (type === 'response.output_item.added' && isRecord(event.item)) {
    if (event.item.type === 'function_call') {
      startToolBlock(controller, state, streamToolKey(event.item), event.item);
    }
    return;
  }

  if (type === 'response.function_call_arguments.delta') {
    const key = streamToolKey(event);
    const block = startToolBlock(controller, state, key, event);
    block.argumentsEmitted = true;
    enqueueEvent(controller, 'content_block_delta', {
      type: 'content_block_delta',
      index: block.index,
      delta: {
        type: 'input_json_delta',
        partial_json: optionalString(event.delta) ?? '',
      },
    });
    return;
  }

  if (type === 'response.output_item.done' && isRecord(event.item)) {
    if (event.item.type !== 'function_call') return;
    const block = startToolBlock(controller, state, streamToolKey(event.item), event.item);
    if (!block.argumentsEmitted && typeof event.item.arguments === 'string') {
      enqueueEvent(controller, 'content_block_delta', {
        type: 'content_block_delta',
        index: block.index,
        delta: {
          type: 'input_json_delta',
          partial_json: event.item.arguments,
        },
      });
    }
    stopBlock(controller, state, block.index);
    return;
  }

  if (type === 'response.completed') {
    completeMessage(controller, state, responseRecordFromEvent(event));
    return;
  }

  if (type === 'response.failed' || type === 'error') {
    const error = isRecord(event.error) ? event.error : event;
    enqueueEvent(controller, 'error', {
      type: 'error',
      error: {
        type: optionalString(error.type) ?? 'api_error',
        message: optionalString(error.message) ?? 'Upstream Responses stream failed.',
      },
    });
    state.messageStopped = true;
  }
}

export function responsesStreamToAnthropicSse(body: ReadableStream<Uint8Array>, model: string) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const state: StreamState = {
        contentIndex: 0,
        messageId: `msg_${crypto.randomUUID()}`,
        messageStarted: false,
        messageStopped: false,
        model,
        openBlocks: new Set(),
        toolBlocks: new Map(),
      };

      try {
        for await (const event of upstreamSseEvents(body)) {
          handleStreamEvent(controller, state, event.event, event.data);
        }

        if (state.messageStarted && !state.messageStopped) {
          completeMessage(controller, state, { model: state.model, usage: {} });
        }
      } catch (cause) {
        enqueueEvent(controller, 'error', {
          type: 'error',
          error: {
            type: 'api_error',
            message: cause instanceof Error ? cause.message : String(cause),
          },
        });
      } finally {
        controller.close();
      }
    },
  });
}

export function grokResponsesHeaders(token: string, model: string, sessionId?: string) {
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'x-grok-client-identifier': 'grok-pager',
    'x-grok-client-version': GROK_BUILD_VERSION,
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-model-override': model,
    'User-Agent': USER_AGENT,
  });
  if (sessionId) headers.set('x-grok-conv-id', sessionId);
  return headers;
}

export function upstreamResponsesUrl() {
  return `${getBaseUrl()}/responses`;
}
