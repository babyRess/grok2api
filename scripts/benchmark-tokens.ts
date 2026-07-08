/**
 * Benchmark proxy throughput (tokens/s) via Anthropic messages stream + non-stream.
 *
 * Usage:
 *   bun scripts/benchmark-tokens.ts
 *   bun scripts/benchmark-tokens.ts --base http://127.0.0.1:8990 --key local-client-key --model grok-build --runs 3
 */

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};

const baseUrl = flag('base', process.env.GROK_BUILD_BENCH_BASE ?? 'http://127.0.0.1:8990').replace(
  /\/+$/,
  '',
);
const apiKey = flag('key', process.env.GROK_BUILD_API_KEY ?? 'local-client-key');
const model = flag('model', process.env.GROK_BUILD_BENCH_MODEL ?? 'grok-build');
const runs = Number.parseInt(flag('runs', process.env.GROK_BUILD_BENCH_RUNS ?? '3'), 10);
const maxTokens = Number.parseInt(flag('max-tokens', '512'), 10);
const prompt =
  flag(
    'prompt',
    'Write a clear technical explanation of how an Anthropic-compatible reverse proxy works. Use about 150-200 words.',
  ) || '';

type RunResult = {
  mode: 'stream' | 'json';
  ok: boolean;
  status: number;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  chars: number;
  tokensPerSec: number;
  error?: string;
};

function headers() {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
  };
}

function body(stream: boolean) {
  return JSON.stringify({
    model,
    max_tokens: maxTokens,
    stream,
    messages: [{ role: 'user', content: prompt }],
  });
}

function tokensFromUsage(usage: unknown) {
  if (!usage || typeof usage !== 'object') return { input: 0, output: 0 };
  const record = usage as Record<string, unknown>;
  const input =
    typeof record.input_tokens === 'number'
      ? record.input_tokens
      : typeof record.prompt_tokens === 'number'
        ? record.prompt_tokens
        : 0;
  const output =
    typeof record.output_tokens === 'number'
      ? record.output_tokens
      : typeof record.completion_tokens === 'number'
        ? record.completion_tokens
        : 0;
  return { input, output };
}

async function runJson(): Promise<RunResult> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: headers(),
    body: body(false),
  });
  const elapsedMs = performance.now() - started;
  const text = await response.text();
  if (!response.ok) {
    return {
      mode: 'json',
      ok: false,
      status: response.status,
      elapsedMs,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      chars: 0,
      tokensPerSec: 0,
      error: text.slice(0, 300),
    };
  }

  const payload = JSON.parse(text) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: unknown;
  };
  const content = (payload.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
  const usage = tokensFromUsage(payload.usage);
  const totalTokens = usage.input + usage.output;
  const seconds = elapsedMs / 1000;
  return {
    mode: 'json',
    ok: true,
    status: response.status,
    elapsedMs,
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens,
    chars: content.length,
    tokensPerSec: seconds > 0 ? usage.output / seconds : 0,
  };
}

async function runStream(): Promise<RunResult> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: headers(),
    body: body(true),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    return {
      mode: 'stream',
      ok: false,
      status: response.status,
      elapsedMs: performance.now() - started,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      chars: 0,
      tokensPerSec: 0,
      error: text.slice(0, 300),
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage = { input: 0, output: 0 };
  let firstTokenAt: number | undefined;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';

    for (const line of parts) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const event = JSON.parse(data) as {
          type?: string;
          delta?: { type?: string; text?: string };
          usage?: unknown;
          message?: { usage?: unknown };
        };
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          if (firstTokenAt === undefined) firstTokenAt = performance.now();
          content += event.delta.text ?? '';
        }
        if (event.type === 'message_delta' && event.usage) usage = tokensFromUsage(event.usage);
        if (event.type === 'message_start' && event.message?.usage) {
          usage = { ...usage, ...tokensFromUsage(event.message.usage) };
        }
      } catch {
        // ignore partial JSON
      }
    }
  }

  const finished = performance.now();
  const elapsedMs = finished - started;
  // Prefer generation window after first token for stream tok/s when available.
  const genMs = firstTokenAt !== undefined ? finished - firstTokenAt : elapsedMs;
  const seconds = genMs / 1000;
  const outputTokens =
    usage.output > 0
      ? usage.output
      : Math.max(1, Math.round(content.split(/\s+/).filter(Boolean).length));

  return {
    mode: 'stream',
    ok: true,
    status: response.status,
    elapsedMs,
    inputTokens: usage.input,
    outputTokens,
    totalTokens: usage.input + outputTokens,
    chars: content.length,
    tokensPerSec: seconds > 0 ? outputTokens / seconds : 0,
  };
}

function printResult(result: RunResult) {
  if (!result.ok) {
    console.log(
      `  [${result.mode}] FAIL HTTP ${result.status} in ${result.elapsedMs.toFixed(0)}ms — ${result.error}`,
    );
    return;
  }
  console.log(
    `  [${result.mode}] ${result.outputTokens} out / ${result.inputTokens} in · ${result.elapsedMs.toFixed(0)}ms · ${result.tokensPerSec.toFixed(1)} tok/s · ${result.chars} chars`,
  );
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

console.log(`Proxy benchmark → ${baseUrl}`);
console.log(`model=${model} runs=${runs} max_tokens=${maxTokens}`);
console.log('');

const streamResults: RunResult[] = [];
const jsonResults: RunResult[] = [];

for (const run of Array.from({ length: runs }, (_, index) => index + 1)) {
  console.log(`Run ${run}/${runs}`);
  const stream = await runStream();
  printResult(stream);
  streamResults.push(stream);

  const json = await runJson();
  printResult(json);
  jsonResults.push(json);
  console.log('');
}

const okStream = streamResults.filter((result) => result.ok);
const okJson = jsonResults.filter((result) => result.ok);

console.log('Summary');
console.log(
  `  stream avg: ${average(okStream.map((result) => result.tokensPerSec)).toFixed(1)} tok/s ` +
    `(n=${okStream.length}, out=${average(okStream.map((result) => result.outputTokens)).toFixed(0)} tokens)`,
);
console.log(
  `  json   avg: ${average(okJson.map((result) => result.tokensPerSec)).toFixed(1)} tok/s ` +
    `(n=${okJson.length}, out=${average(okJson.map((result) => result.outputTokens)).toFixed(0)} tokens)`,
);
console.log(
  `  stream TTFT-aware tok/s uses time from first content token to end; json tok/s is end-to-end.`,
);

if (okStream.length === 0 && okJson.length === 0) process.exit(1);
