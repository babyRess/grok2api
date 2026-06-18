import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import {
  type AnthropicApiEnvironment,
  AnthropicApiError,
  anthropicErrorResponse,
  anthropicMessagesToResponsesPayload,
  anthropicModelsPayload,
  clientAuthError,
  countAnthropicTokens,
  grokResponsesHeaders,
  responsesJsonToAnthropicMessage,
  responsesStreamToAnthropicSse,
  sessionIdFromHeaders,
  upstreamResponsesUrl,
  upstreamToken,
} from './anthropic.js';

export type AnthropicApiHandlerOptions = {
  cwd?: string;
  env?: AnthropicApiEnvironment;
  fetch?: typeof fetch;
};

export type AnthropicApiServerOptions = AnthropicApiHandlerOptions & {
  host?: string;
  port?: number;
};

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

function routeIsCountTokens(pathname: string) {
  return pathname === '/v1/messages/count_tokens' || pathname === '/cc/v1/messages/count_tokens';
}

async function handleMessages(request: Request, options: AnthropicApiHandlerOptions) {
  const token = upstreamToken(options.env ?? process.env);
  if (!token) {
    return anthropicErrorResponse(
      401,
      'GROK_BUILD_OAUTH_TOKEN or GROK_BUILD_ACCESS_TOKEN is required for /messages.',
      'authentication_error',
    );
  }

  const body = await requestJson(request);
  const payload = anthropicMessagesToResponsesPayload(body, request.headers, {
    cwd: options.cwd,
  });
  const model = typeof payload.model === 'string' ? payload.model : '';
  const headers = grokResponsesHeaders(token, model, sessionIdFromHeaders(request.headers));
  if (payload.stream === true) headers.set('accept', 'text/event-stream');

  const response = await (options.fetch ?? fetch)(upstreamResponsesUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) return upstreamErrorResponse(response);

  if (payload.stream === true) {
    if (!response.body) {
      return anthropicErrorResponse(502, 'Upstream Grok Build stream response had no body.');
    }
    return new Response(responsesStreamToAnthropicSse(response.body, model), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  return Response.json(responsesJsonToAnthropicMessage(await response.json(), model));
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

    const authError = clientAuthError(request, options.env ?? process.env);
    if (authError) return authError;

    if (request.method === 'GET' && pathname === '/v1/models') {
      return Response.json(anthropicModelsPayload());
    }

    if (request.method === 'POST' && routeIsCountTokens(pathname)) {
      return Response.json(countAnthropicTokens(await requestJson(request)));
    }

    if (request.method === 'POST' && routeIsMessages(pathname)) {
      return handleMessages(request, options);
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
