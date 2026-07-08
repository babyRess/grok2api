import { getBaseUrl } from '../auth/oauth.js';
import { resolveModels, upstreamModelId } from '../models/catalog.js';
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

export type ToolUseConversionOptions = {
  allowedToolNames?: Iterable<string>;
};

type ResolvedToolUseConversionOptions = {
  allowedToolNames?: ReadonlySet<string>;
};

export type OpenAIChatCompletionOptions = ToolUseConversionOptions & {
  created?: number;
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

function resolvedToolUseOptions(
  options: ToolUseConversionOptions = {},
): ResolvedToolUseConversionOptions {
  return options.allowedToolNames ? { allowedToolNames: new Set(options.allowedToolNames) } : {};
}

function toolNameAllowed(name: string, options: ResolvedToolUseConversionOptions) {
  return options.allowedToolNames === undefined || options.allowedToolNames.has(name);
}

function anthropicToolNames(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tool): string[] =>
    isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : [],
  );
}

export function anthropicToolNamesFromRequest(body: unknown) {
  return new Set(isRecord(body) ? anthropicToolNames(body.tools) : []);
}

export function openAIToolNamesFromRequest(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.tools)) return new Set<string>();
  return new Set(
    body.tools.flatMap((tool): string[] => {
      if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) return [];
      return typeof tool.function.name === 'string' ? [tool.function.name] : [];
    }),
  );
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

/** Single client key for this proxy gateway (admin UI + /v1 clients). */
export const DEFAULT_PROXY_API_KEY = 'local-client-key';

export function resolveProxyApiKey(env: AnthropicApiEnvironment = process.env) {
  const configured = env.GROK_BUILD_API_KEY?.trim();
  return configured || DEFAULT_PROXY_API_KEY;
}

export function clientAuthError(request: Request, env = process.env): Response | undefined {
  const expected = resolveProxyApiKey(env);
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if ([request.headers.get('x-api-key'), bearer].some((provided) => provided === expected)) {
    return undefined;
  }

  return anthropicErrorResponse(
    401,
    'Invalid or missing proxy API key. Use the same GROK_BUILD_API_KEY as x-api-key or Authorization: Bearer.',
    'authentication_error',
  );
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

function openAIContentBlock(block: unknown): unknown {
  if (typeof block === 'string') return block;
  if (!isRecord(block)) return undefined;
  if (block.type === 'text' && typeof block.text === 'string') return block;
  if (block.type === 'image_url') {
    const imageUrl = isRecord(block.image_url) ? block.image_url.url : block.image_url;
    return typeof imageUrl === 'string'
      ? { type: 'image', source: { type: 'url', url: imageUrl } }
      : undefined;
  }
  return block;
}

function openAIMessageContent(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(openAIContentBlock).filter((block) => block !== undefined);
}

function anthropicToolUseFromOpenAIToolCall(toolCall: unknown): JsonRecord | undefined {
  if (!isRecord(toolCall)) return undefined;
  const callFunction = isRecord(toolCall.function) ? toolCall.function : {};
  if (typeof callFunction.name !== 'string') return undefined;
  return {
    type: 'tool_use',
    id: optionalString(toolCall.id) ?? `call_${crypto.randomUUID()}`,
    name: callFunction.name,
    input: parseJsonRecord(optionalString(callFunction.arguments) ?? '{}'),
  };
}

function anthropicMessagesFromOpenAI(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) {
    throw new AnthropicApiError(400, 'invalid_request_error', '`messages` must be an array.');
  }

  return value.flatMap((message): JsonRecord[] => {
    if (!isRecord(message)) return [];
    const role = optionalString(message.role) ?? 'user';
    if (role === 'system' || role === 'developer') return [];
    if (role === 'tool') {
      return [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: optionalString(message.tool_call_id) ?? 'tool_result_unknown',
              content: openAIMessageContent(message.content),
            },
          ],
        },
      ];
    }

    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
          .map(anthropicToolUseFromOpenAIToolCall)
          .filter((toolCall): toolCall is JsonRecord => !!toolCall)
      : [];
    const content = [...contentBlocks(openAIMessageContent(message.content)), ...toolCalls].filter(
      (block) => block !== undefined,
    );

    return [{ role: role === 'assistant' ? 'assistant' : 'user', content }];
  });
}

function openAISystemFromMessages(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;

  const system = value
    .flatMap((message): string[] => {
      if (!isRecord(message)) return [];
      if (message.role !== 'system' && message.role !== 'developer') return [];
      return jsonStrings(message.content);
    })
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
  return system || undefined;
}

function anthropicToolsFromOpenAI(value: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const tools = value.flatMap((tool): JsonRecord[] => {
    if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) return [];
    if (typeof tool.function.name !== 'string') return [];
    return [
      {
        name: tool.function.name,
        ...(typeof tool.function.description === 'string'
          ? { description: tool.function.description }
          : {}),
        input_schema: isRecord(tool.function.parameters)
          ? tool.function.parameters
          : { type: 'object', properties: {} },
      },
    ];
  });

  return tools.length > 0 ? tools : undefined;
}

function anthropicToolChoiceFromOpenAI(value: unknown): unknown {
  if (value === 'required') return 'any';
  if (value === 'auto' || value === 'none') return value;
  if (!isRecord(value)) return undefined;
  if (value.type !== 'function' || !isRecord(value.function)) return undefined;
  return typeof value.function.name === 'string'
    ? { type: 'tool', name: value.function.name }
    : undefined;
}

export function openAIChatCompletionToAnthropicMessages(body: unknown) {
  if (!isRecord(body)) {
    throw new AnthropicApiError(
      400,
      'invalid_request_error',
      'Request body must be a JSON object.',
    );
  }

  const model = optionalString(body.model);
  if (!model) throw new AnthropicApiError(400, 'invalid_request_error', '`model` is required.');

  const anthropic: JsonRecord = {
    model,
    messages: anthropicMessagesFromOpenAI(body.messages),
  };

  const system = openAISystemFromMessages(body.messages);
  if (system) anthropic.system = system;
  if (optionalNumber(body.max_tokens) !== undefined) anthropic.max_tokens = body.max_tokens;
  if (optionalNumber(body.max_completion_tokens) !== undefined) {
    anthropic.max_tokens = body.max_completion_tokens;
  }
  if (optionalNumber(body.temperature) !== undefined) anthropic.temperature = body.temperature;
  if (optionalNumber(body.top_p) !== undefined) anthropic.top_p = body.top_p;
  if (typeof body.stream === 'boolean') anthropic.stream = body.stream;
  if (typeof body.stop === 'string') anthropic.stop_sequences = [body.stop];
  if (Array.isArray(body.stop)) anthropic.stop_sequences = body.stop;

  const tools = anthropicToolsFromOpenAI(body.tools);
  if (tools) anthropic.tools = tools;

  const toolChoice = anthropicToolChoiceFromOpenAI(body.tool_choice);
  if (toolChoice) anthropic.tool_choice = toolChoice;

  return anthropic;
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

function toolCompatibilityInstructions(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;

  const names = anthropicToolNames(value);
  if (names.length === 0) {
    return 'Tool compatibility: no tools are available in this request. Do not call tools.';
  }

  return [
    `Tool compatibility: only call tools included in this request: ${names.join(', ')}.`,
    'Do not invent or call unavailable tool names. Names are case-sensitive.',
    ...(names.includes('Bash') && !names.includes('Glob')
      ? ['For file discovery or globbing, call Bash with find, fd, or grep commands.']
      : []),
    ...(names.includes('web_search') && !names.includes('WebSearch')
      ? ['For web search, call web_search exactly; do not call WebSearch.']
      : []),
    ...(!names.includes('web_search') && !names.includes('WebSearch')
      ? ['If no web search tool is listed, explain that web search is unavailable in this session.']
      : []),
  ].join('\n');
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

  const upstreamModel = upstreamModelId(model);
  const payload: JsonRecord = {
    model: upstreamModel,
    input: responsesInputFromMessages(body.messages),
  };

  const instructions = [
    instructionsFromSystem(body.system),
    toolCompatibilityInstructions(body.tools),
  ]
    .filter((part): part is string => !!part)
    .join('\n\n');
  if (instructions) payload.instructions = instructions;
  if (optionalNumber(body.max_tokens) !== undefined) payload.max_output_tokens = body.max_tokens;
  if (optionalNumber(body.temperature) !== undefined) payload.temperature = body.temperature;
  if (optionalNumber(body.top_p) !== undefined) payload.top_p = body.top_p;
  if (typeof body.stream === 'boolean') payload.stream = body.stream;
  if (Array.isArray(body.stop_sequences)) payload.stop = body.stop_sequences;

  const tools = responsesTools(body.tools);
  if (tools) payload.tools = tools;

  const toolChoice = responsesToolChoice(body.tool_choice);
  if (toolChoice) payload.tool_choice = toolChoice;

  const reasoning = responsesReasoning(body.thinking);
  if (reasoning) payload.reasoning = reasoning;

  return sanitizePayload(
    payload,
    upstreamModel,
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

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function bashInputForUnavailableTool(name: string, input: JsonRecord) {
  if (name.toLowerCase() !== 'glob') return undefined;

  const pattern =
    optionalString(input.pattern) ??
    optionalString(input.glob) ??
    optionalString(input.path) ??
    '*';
  const relativePattern = pattern.replace(/^\.?\//, '') || '*';
  return {
    command: [
      'if command -v fd >/dev/null 2>&1; then',
      `  fd --hidden --glob ${shellQuote(relativePattern)} .`,
      'else',
      `  find . -path ${shellQuote(`./${relativePattern}`)} -print`,
      'fi',
    ].join('\n'),
  };
}

function translatedToolUseName(name: string, options: ResolvedToolUseConversionOptions) {
  if (!options.allowedToolNames?.has('Bash')) return undefined;
  return bashInputForUnavailableTool(name, {}) ? 'Bash' : undefined;
}

function toolUseBlockFromFunctionCall(
  item: JsonRecord,
  options: ResolvedToolUseConversionOptions = {},
) {
  const name = optionalString(item.name) ?? 'tool';
  const input = parsedToolInput(item.arguments);
  if (toolNameAllowed(name, options)) {
    return {
      type: 'tool_use',
      id: optionalString(item.call_id) ?? optionalString(item.id) ?? 'tool_use_unknown',
      name,
      input,
    };
  }

  const bashInput = options.allowedToolNames?.has('Bash')
    ? bashInputForUnavailableTool(name, input)
    : undefined;
  if (!bashInput) return undefined;

  return {
    type: 'tool_use',
    id: optionalString(item.call_id) ?? optionalString(item.id) ?? 'tool_use_unknown',
    name: 'Bash',
    input: bashInput,
  };
}

function contentFromOutputItem(
  item: unknown,
  options: ResolvedToolUseConversionOptions = {},
): JsonRecord[] {
  if (!isRecord(item)) return [];

  if (item.type === 'message' && Array.isArray(item.content)) {
    return item.content
      .map(outputTextContent)
      .filter((text): text is string => text !== undefined)
      .map((text) => ({ text, type: 'text' }));
  }

  if (item.type === 'function_call') {
    const toolUse = toolUseBlockFromFunctionCall(item, options);
    if (toolUse) return [toolUse];
    return [];
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

function openAIUsageFromAnthropicUsage(value: unknown) {
  const usage = isRecord(value) ? value : {};
  const promptTokens = optionalNumber(usage.input_tokens) ?? 0;
  const completionTokens = optionalNumber(usage.output_tokens) ?? 0;
  const cachedTokens = optionalNumber(usage.cache_read_input_tokens);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(cachedTokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
      : {}),
  };
}

function openAIFinishReason(stopReason: unknown) {
  if (stopReason === 'tool_use') return 'tool_calls';
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'stop_sequence' || stopReason === 'end_turn') return 'stop';
  return 'stop';
}

function openAIMessageFromAnthropicContent(content: unknown) {
  const contentItems = Array.isArray(content) ? content : [];
  const text = contentItems
    .flatMap((part): string[] =>
      isRecord(part) && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('');
  const toolCalls = contentItems.flatMap((part, index): JsonRecord[] => {
    if (!isRecord(part) || part.type !== 'tool_use') return [];
    return [
      {
        id: optionalString(part.id) ?? `call_${index}`,
        type: 'function',
        function: {
          name: optionalString(part.name) ?? 'tool',
          arguments: JSON.stringify(isRecord(part.input) ? part.input : {}),
        },
      },
    ];
  });

  return {
    role: 'assistant',
    content: toolCalls.length > 0 ? text || null : text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

export function responsesJsonToOpenAIChatCompletion(
  value: unknown,
  requestedModel?: string,
  options: OpenAIChatCompletionOptions = {},
) {
  const message = responsesJsonToAnthropicMessage(value, requestedModel, options);
  return {
    id: message.id,
    object: 'chat.completion',
    created: options.created ?? Math.floor(Date.now() / 1000),
    model: message.model,
    choices: [
      {
        index: 0,
        message: openAIMessageFromAnthropicContent(message.content),
        finish_reason: openAIFinishReason(message.stop_reason),
      },
    ],
    usage: openAIUsageFromAnthropicUsage(message.usage),
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
  if (reason === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}

export function responsesJsonToAnthropicMessage(
  value: unknown,
  requestedModel?: string,
  options: ToolUseConversionOptions = {},
) {
  const response = isRecord(value) ? value : {};
  const conversionOptions = resolvedToolUseOptions(options);
  const content = Array.isArray(response.output)
    ? response.output.flatMap((item) => contentFromOutputItem(item, conversionOptions))
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

function openAIChatCompletionChunk(
  id: string,
  model: string,
  delta: JsonRecord,
  finishReason: string | null = null,
  usage?: JsonRecord,
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

function openAISse(data: JsonRecord | '[DONE]') {
  return `data: ${data === '[DONE]' ? data : JSON.stringify(data)}\n\n`;
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

type StreamToolBlock = {
  index: number;
  argumentsEmitted: boolean;
  argumentDeltas: string[];
  translatedFrom?: string;
};

type StreamState = {
  blockedToolBlocks: Set<string>;
  contentIndex: number;
  conversionOptions: ResolvedToolUseConversionOptions;
  messageId: string;
  messageStarted: boolean;
  messageStopped: boolean;
  model: string;
  openBlocks: Set<number>;
  textBlockIndex?: number;
  toolBlocks: Map<string, StreamToolBlock>;
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
  if (streamToolKeys(item ?? { id: key }).some((toolKey) => state.blockedToolBlocks.has(toolKey))) {
    return undefined;
  }

  const existing =
    streamToolKeys(item ?? { id: key })
      .map((toolKey) => state.toolBlocks.get(toolKey))
      .find((block): block is StreamToolBlock => !!block) ?? state.toolBlocks.get(key);
  if (existing && state.openBlocks.has(existing.index)) return existing;

  const name = optionalString(item?.name) ?? 'tool';
  const translatedName = toolNameAllowed(name, state.conversionOptions)
    ? undefined
    : translatedToolUseName(name, state.conversionOptions);
  if (!toolNameAllowed(name, state.conversionOptions) && !translatedName) {
    streamToolKeys(item ?? { id: key }).forEach((toolKey) => {
      state.blockedToolBlocks.add(toolKey);
    });
    return undefined;
  }

  ensureMessageStart(controller, state);
  const index = state.contentIndex;
  state.contentIndex += 1;
  const block = {
    index,
    argumentsEmitted: false,
    argumentDeltas: [],
    ...(translatedName ? { translatedFrom: name } : {}),
  };
  streamToolKeys(item ?? { id: key }).forEach((toolKey) => {
    state.toolBlocks.set(toolKey, block);
  });
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
      name: translatedName ?? name,
      input: {},
    },
  });
  return block;
}

function streamToolArguments(block: StreamToolBlock, item: JsonRecord) {
  if (!block.translatedFrom) return optionalString(item.arguments) ?? '';
  return JSON.stringify(
    bashInputForUnavailableTool(
      block.translatedFrom,
      parsedToolInput(optionalString(item.arguments) ?? block.argumentDeltas.join('')),
    ) ?? {},
  );
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
  return streamToolKeys(event)[0] ?? String(optionalNumber(event.output_index) ?? 0);
}

function streamToolKeys(event: JsonRecord) {
  return [
    optionalString(event.item_id) ??
      optionalString(event.output_item_id) ??
      optionalString(event.id) ??
      optionalString(event.call_id) ??
      String(optionalNumber(event.output_index) ?? 0),
    optionalString(event.item_id),
    optionalString(event.output_item_id),
    optionalString(event.id),
    optionalString(event.call_id),
    optionalNumber(event.output_index) !== undefined
      ? String(optionalNumber(event.output_index))
      : undefined,
  ].filter(
    (toolKey, index, toolKeys): toolKey is string =>
      toolKey !== undefined && toolKey.length > 0 && toolKeys.indexOf(toolKey) === index,
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
  const message = responsesJsonToAnthropicMessage(response, state.model, state.conversionOptions);

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

function emitMissingToolArgumentsFromCompleted(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: StreamState,
  response: JsonRecord,
) {
  if (!Array.isArray(response.output)) return;

  for (const item of response.output) {
    if (!isRecord(item) || item.type !== 'function_call') continue;
    const block = streamToolKeys(item)
      .map((toolKey) => state.toolBlocks.get(toolKey))
      .find((candidate): candidate is StreamToolBlock => !!candidate);
    if (!block || block.argumentsEmitted || !state.openBlocks.has(block.index)) continue;

    block.argumentsEmitted = true;
    enqueueEvent(controller, 'content_block_delta', {
      type: 'content_block_delta',
      index: block.index,
      delta: {
        type: 'input_json_delta',
        partial_json: streamToolArguments(block, item),
      },
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
  emitMissingToolArgumentsFromCompleted(controller, state, response);

  for (const index of [...state.openBlocks]) stopBlock(controller, state, index);

  const message = responsesJsonToAnthropicMessage(response, state.model, state.conversionOptions);
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

function emitIncompleteStreamError(
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: StreamState,
) {
  if (state.messageStopped) return;
  for (const index of [...state.openBlocks]) stopBlock(controller, state, index);
  enqueueEvent(controller, 'error', {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'Upstream Responses stream ended before response.completed.',
    },
  });
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
    if (!block) return;
    if (block.translatedFrom) {
      block.argumentDeltas.push(optionalString(event.delta) ?? '');
      return;
    }
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
    if (!block) return;
    if (
      !block.argumentsEmitted &&
      (block.translatedFrom || typeof event.item.arguments === 'string')
    ) {
      block.argumentsEmitted = true;
      enqueueEvent(controller, 'content_block_delta', {
        type: 'content_block_delta',
        index: block.index,
        delta: {
          type: 'input_json_delta',
          partial_json: streamToolArguments(block, event.item),
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

export function responsesStreamToAnthropicSse(
  body: ReadableStream<Uint8Array>,
  model: string,
  options: ToolUseConversionOptions = {},
) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const state: StreamState = {
        blockedToolBlocks: new Set(),
        contentIndex: 0,
        conversionOptions: resolvedToolUseOptions(options),
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

        emitIncompleteStreamError(controller, state);
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

export function responsesStreamToOpenAIChatCompletionsSse(
  body: ReadableStream<Uint8Array>,
  model: string,
  options: ToolUseConversionOptions = {},
) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let id = `chatcmpl_${crypto.randomUUID()}`;
      let responseModel = model;
      let roleSent = false;
      const blockedToolCalls = new Set<string>();
      const conversionOptions = resolvedToolUseOptions(options);
      const toolIndexes = new Map<string, number>();
      let streamStopped = false;

      const enqueue = (chunk: JsonRecord | '[DONE]') => {
        controller.enqueue(encoder.encode(openAISse(chunk)));
      };

      try {
        for await (const item of upstreamSseEvents(body)) {
          const type = eventType(item.event, item.data);
          const event = isRecord(item.data) ? item.data : {};

          if (type === 'response.created') {
            const response = responseRecordFromEvent(event);
            id = optionalString(response.id) ?? id;
            responseModel = optionalString(response.model) ?? responseModel;
            enqueue(openAIChatCompletionChunk(id, responseModel, { role: 'assistant' }));
            roleSent = true;
            continue;
          }

          if (!roleSent) {
            enqueue(openAIChatCompletionChunk(id, responseModel, { role: 'assistant' }));
            roleSent = true;
          }

          if (type === 'response.output_text.delta') {
            enqueue(
              openAIChatCompletionChunk(id, responseModel, {
                content: optionalString(event.delta) ?? optionalString(event.text) ?? '',
              }),
            );
            continue;
          }

          if (type === 'response.output_item.added' && isRecord(event.item)) {
            if (event.item.type !== 'function_call') continue;
            const key = streamToolKey(event.item);
            const name = optionalString(event.item.name) ?? 'tool';
            if (!toolNameAllowed(name, conversionOptions)) {
              blockedToolCalls.add(key);
              continue;
            }

            const index = toolIndexes.size;
            toolIndexes.set(key, index);
            enqueue(
              openAIChatCompletionChunk(id, responseModel, {
                tool_calls: [
                  {
                    index,
                    id: optionalString(event.item.call_id) ?? optionalString(event.item.id) ?? key,
                    type: 'function',
                    function: {
                      name,
                      arguments: '',
                    },
                  },
                ],
              }),
            );
            continue;
          }

          if (type === 'response.function_call_arguments.delta') {
            const key = streamToolKey(event);
            if (blockedToolCalls.has(key)) continue;
            const index = toolIndexes.get(key) ?? toolIndexes.size;
            if (!toolIndexes.has(key)) toolIndexes.set(key, index);
            enqueue(
              openAIChatCompletionChunk(id, responseModel, {
                tool_calls: [
                  {
                    index,
                    function: { arguments: optionalString(event.delta) ?? '' },
                  },
                ],
              }),
            );
            continue;
          }

          if (type === 'response.completed') {
            const message = responsesJsonToAnthropicMessage(
              responseRecordFromEvent(event),
              responseModel,
              conversionOptions,
            );
            enqueue(
              openAIChatCompletionChunk(
                id,
                message.model,
                {},
                openAIFinishReason(message.stop_reason),
                openAIUsageFromAnthropicUsage(message.usage),
              ),
            );
            enqueue('[DONE]');
            streamStopped = true;
            continue;
          }

          if (type === 'response.failed' || type === 'error') {
            const error = isRecord(event.error) ? event.error : event;
            enqueue({
              error: {
                type: optionalString(error.type) ?? 'api_error',
                message: optionalString(error.message) ?? 'Upstream Responses stream failed.',
              },
            });
            enqueue('[DONE]');
            streamStopped = true;
          }
        }

        if (!streamStopped) {
          enqueue({
            error: {
              type: 'api_error',
              message: 'Upstream Responses stream ended before response.completed.',
            },
          });
          enqueue('[DONE]');
        }
      } catch (cause) {
        enqueue({
          error: {
            type: 'api_error',
            message: cause instanceof Error ? cause.message : String(cause),
          },
        });
        enqueue('[DONE]');
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
