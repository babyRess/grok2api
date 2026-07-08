import { DEFAULT_PROXY_API_KEY, resolveProxyApiKey } from './anthropic.js';
import { startAnthropicApiServer } from './server.js';

if (!process.env.GROK_BUILD_API_KEY?.trim()) {
  process.env.GROK_BUILD_API_KEY = DEFAULT_PROXY_API_KEY;
}

const server = await startAnthropicApiServer();
const proxyKey = resolveProxyApiKey();

console.log(`open-grok-build Anthropic API listening on ${server.url}`);
console.log(`proxy base URL: ${server.url}/v1`);
console.log(
  process.env.GROK_BUILD_API_KEY === DEFAULT_PROXY_API_KEY
    ? `proxy API key: ${proxyKey} (default — set GROK_BUILD_API_KEY to override)`
    : 'proxy API key: configured via GROK_BUILD_API_KEY',
);
