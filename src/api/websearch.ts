import { type AnthropicApiEnvironment, AnthropicApiError } from './anthropic.js';

type JsonRecord = Record<string, unknown>;

type WebSearchResult = {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: number;
};

export type WebSearchHandlerOptions = {
  env?: AnthropicApiEnvironment;
  fetch?: typeof fetch;
  inputTokens?: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function webSearchLimit(env: AnthropicApiEnvironment) {
  const parsed = Number.parseInt(env.GROK_BUILD_WEB_SEARCH_MAX_RESULTS ?? '', 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(10, Math.max(1, parsed));
}

function isWebSearchTool(tool: unknown) {
  if (!isRecord(tool)) return false;
  const name = optionalString(tool.name);
  const type = optionalString(tool.type);
  return name === 'web_search' || name === 'WebSearch' || !!type?.startsWith('web_search');
}

export function isWebSearchOnlyRequest(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.tools)) return false;
  return body.tools.length === 1 && isWebSearchTool(body.tools[0]);
}

function contentBlocks(value: unknown): unknown[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return [];
}

function messageText(message: unknown): string[] {
  if (!isRecord(message)) return [];
  return contentBlocks(message.content).flatMap((block): string[] => {
    if (typeof block === 'string') return [block];
    if (!isRecord(block) || block.type !== 'text') return [];
    return typeof block.text === 'string' ? [block.text] : [];
  });
}

export function extractWebSearchQuery(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.messages)) return undefined;

  const text = [...body.messages]
    .reverse()
    .flatMap(messageText)
    .map((part) => part.trim())
    .find(Boolean);
  if (!text) return undefined;

  const prefix = 'Perform a web search for the query: ';
  return text.startsWith(prefix) ? text.slice(prefix.length).trim() || undefined : text;
}

function resultFromRecord(value: unknown): WebSearchResult | undefined {
  if (!isRecord(value)) return undefined;
  const title =
    optionalString(value.title) ??
    optionalString(value.name) ??
    optionalString(value.heading) ??
    optionalString(value.Heading) ??
    optionalString(value.Text)?.split(' - ')[0]?.trim();
  const url =
    optionalString(value.url) ??
    optionalString(value.link) ??
    optionalString(value.href) ??
    optionalString(value.FirstURL);
  if (!title || !url) return undefined;

  const snippet =
    optionalString(value.snippet) ??
    optionalString(value.description) ??
    optionalString(value.content) ??
    optionalString(value.AbstractText) ??
    optionalString(value.Text);
  return {
    title,
    url,
    ...(snippet ? { snippet } : {}),
    ...(optionalNumber(value.publishedDate) !== undefined
      ? { publishedDate: optionalNumber(value.publishedDate) }
      : {}),
  };
}

function duckRelatedTopics(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): unknown[] =>
    isRecord(item) && Array.isArray(item.Topics) ? duckRelatedTopics(item.Topics) : [item],
  );
}

function payloadResults(value: unknown) {
  if (!isRecord(value)) return [];

  return [
    ...(Array.isArray(value.results) ? value.results : []),
    ...(Array.isArray(value.items) ? value.items : []),
    ...(Array.isArray(value.organic_results) ? value.organic_results : []),
    ...(isRecord(value.web) && Array.isArray(value.web.results) ? value.web.results : []),
    ...(optionalString(value.AbstractURL)
      ? [
          {
            title: optionalString(value.Heading) ?? 'DuckDuckGo result',
            url: value.AbstractURL,
            snippet: value.AbstractText,
          },
        ]
      : []),
    ...duckRelatedTopics(value.RelatedTopics),
  ];
}

function uniqueResults(results: WebSearchResult[], limit: number) {
  const seen = new Set<string>();
  return results
    .filter((result) => {
      if (seen.has(result.url)) return false;
      seen.add(result.url);
      return true;
    })
    .slice(0, limit);
}

function webSearchResultsFromPayload(value: unknown, limit: number) {
  return uniqueResults(
    payloadResults(value)
      .map(resultFromRecord)
      .filter((result): result is WebSearchResult => !!result),
    limit,
  );
}

async function jsonResponse(response: Response, provider: string) {
  if (!response.ok) {
    throw new AnthropicApiError(
      502,
      'api_error',
      `${provider} web search failed with ${response.status}.`,
    );
  }
  return (await response.json()) as unknown;
}

async function searchCustomEndpoint(
  query: string,
  env: AnthropicApiEnvironment,
  fetcher: typeof fetch,
  limit: number,
) {
  const endpoint = optionalString(env.GROK_BUILD_WEB_SEARCH_ENDPOINT);
  if (!endpoint) return undefined;

  const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
  const apiKey = optionalString(env.GROK_BUILD_WEB_SEARCH_API_KEY);
  if (apiKey) {
    const header = optionalString(env.GROK_BUILD_WEB_SEARCH_AUTH_HEADER) ?? 'authorization';
    headers.set(header, header.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : apiKey);
  }

  return webSearchResultsFromPayload(
    await jsonResponse(
      await fetcher(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, count: limit }),
      }),
      'Configured',
    ),
    limit,
  );
}

async function searchBrave(
  query: string,
  env: AnthropicApiEnvironment,
  fetcher: typeof fetch,
  limit: number,
) {
  const apiKey = optionalString(env.GROK_BUILD_BRAVE_SEARCH_API_KEY);
  if (!apiKey) return undefined;

  const url = new URL(
    optionalString(env.GROK_BUILD_BRAVE_SEARCH_ENDPOINT) ??
      'https://api.search.brave.com/res/v1/web/search',
  );
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(limit));
  return webSearchResultsFromPayload(
    await jsonResponse(
      await fetcher(url, {
        headers: {
          accept: 'application/json',
          'x-subscription-token': apiKey,
        },
      }),
      'Brave',
    ),
    limit,
  );
}

async function searchDuckDuckGo(query: string, fetcher: typeof fetch, limit: number) {
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');
  return webSearchResultsFromPayload(
    await jsonResponse(
      await fetcher(url, { headers: { accept: 'application/json' } }),
      'DuckDuckGo',
    ),
    limit,
  );
}

async function searchWeb(query: string, options: WebSearchHandlerOptions) {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? fetch;
  const limit = webSearchLimit(env);

  return (
    (await searchCustomEndpoint(query, env, fetcher, limit)) ??
    (await searchBrave(query, env, fetcher, limit)) ??
    (await searchDuckDuckGo(query, fetcher, limit))
  );
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.replace(/\s+/g, ' ').trim().length / 4));
}

function pageAge(result: WebSearchResult) {
  if (result.publishedDate === undefined) return undefined;
  return new Date(result.publishedDate).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function searchToolResultContent(results: WebSearchResult[]) {
  return results.map((result) => ({
    type: 'web_search_result',
    title: result.title,
    url: result.url,
    encrypted_content: result.snippet ?? '',
    ...(pageAge(result) ? { page_age: pageAge(result) } : {}),
  }));
}

function searchSummary(query: string, results: WebSearchResult[]) {
  if (results.length === 0) {
    return `No web search results were found for "${query}".`;
  }

  return [
    `Here are the web search results for "${query}":`,
    '',
    ...results.map((result, index) =>
      [
        `${index + 1}. ${result.title}`,
        result.snippet ? `   ${result.snippet}` : '',
        `   Source: ${result.url}`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ].join('\n');
}

function chunkText(text: string) {
  const chars = [...text];
  return Array.from({ length: Math.ceil(chars.length / 100) }, (_, index) =>
    chars.slice(index * 100, index * 100 + 100).join(''),
  );
}

function sse(event: string, data: JsonRecord) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function enqueueEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: string,
  data: JsonRecord,
) {
  controller.enqueue(new TextEncoder().encode(sse(event, data)));
}

function contentBlocksForSearch(query: string, toolUseId: string, results: WebSearchResult[]) {
  return [
    { type: 'text', text: `I'll search for "${query}".` },
    {
      id: toolUseId,
      type: 'server_tool_use',
      name: 'web_search',
      input: { query },
    },
    {
      type: 'web_search_tool_result',
      content: searchToolResultContent(results),
    },
    { type: 'text', text: searchSummary(query, results) },
  ];
}

function messageUsage(inputTokens: number, summary: string) {
  return {
    input_tokens: inputTokens,
    output_tokens: estimateTokens(summary),
    server_tool_use: { web_search_requests: 1 },
  };
}

function randomId(prefix: string, length: number) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, length)}`;
}

function webSearchJsonMessage(
  body: JsonRecord,
  query: string,
  results: WebSearchResult[],
  inputTokens: number,
) {
  const toolUseId = randomId('srvtoolu', 32);
  const summary = searchSummary(query, results);
  return {
    id: randomId('msg', 24),
    type: 'message',
    role: 'assistant',
    model: optionalString(body.model) ?? '',
    content: contentBlocksForSearch(query, toolUseId, results),
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: messageUsage(inputTokens, summary),
  };
}

function webSearchSseStream(
  body: JsonRecord,
  query: string,
  results: WebSearchResult[],
  inputTokens: number,
) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const model = optionalString(body.model) ?? '';
      const messageId = randomId('msg', 24);
      const toolUseId = randomId('srvtoolu', 32);
      const summary = searchSummary(query, results);

      enqueueEvent(controller, 'message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
      enqueueEvent(controller, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      enqueueEvent(controller, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `I'll search for "${query}".` },
      });
      enqueueEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      enqueueEvent(controller, 'content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: {
          id: toolUseId,
          type: 'server_tool_use',
          name: 'web_search',
          input: { query },
        },
      });
      enqueueEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: 1 });
      enqueueEvent(controller, 'content_block_start', {
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'web_search_tool_result',
          content: searchToolResultContent(results),
        },
      });
      enqueueEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: 2 });
      enqueueEvent(controller, 'content_block_start', {
        type: 'content_block_start',
        index: 3,
        content_block: { type: 'text', text: '' },
      });
      for (const text of chunkText(summary)) {
        enqueueEvent(controller, 'content_block_delta', {
          type: 'content_block_delta',
          index: 3,
          delta: { type: 'text_delta', text },
        });
      }
      enqueueEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: 3 });
      enqueueEvent(controller, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: messageUsage(inputTokens, summary),
      });
      enqueueEvent(controller, 'message_stop', { type: 'message_stop' });
      controller.close();
    },
  });
}

export async function webSearchAnthropicResponse(
  body: unknown,
  options: WebSearchHandlerOptions = {},
) {
  if (!isRecord(body)) {
    throw new AnthropicApiError(400, 'invalid_request_error', 'Request body must be an object.');
  }

  const query = extractWebSearchQuery(body);
  if (!query) {
    throw new AnthropicApiError(
      400,
      'invalid_request_error',
      'Could not extract a web_search query from the request messages.',
    );
  }

  const results = await searchWeb(query, options);
  const inputTokens = options.inputTokens ?? estimateTokens(query);
  if (body.stream === true) {
    return new Response(webSearchSseStream(body, query, results, inputTokens), {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  return Response.json(webSearchJsonMessage(body, query, results, inputTokens));
}
