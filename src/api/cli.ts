import { startAnthropicApiServer } from './server.js';

const server = await startAnthropicApiServer();

console.log(`open-grok-build Anthropic API listening on ${server.url}`);
