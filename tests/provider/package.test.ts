import { existsSync, globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('repository layout', () => {
  it('keeps the API gateway entry at src/index.ts', () => {
    expect(existsSync(new URL('../../src/index.ts', import.meta.url))).toBe(true);
  });

  it('does not ship legacy provider entry or custom tool shims', () => {
    expect(existsSync(new URL('../../src/provider/register.ts', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../../src/tools', import.meta.url))).toBe(false);
  });

  it('contains core domain source files', () => {
    const files = globSync('src/**/*.{ts,tsx}').sort();
    for (const required of [
      'src/auth/oauth.ts',
      'src/api/accounts.ts',
      'src/api/index.ts',
      'src/api/server.ts',
      'src/index.ts',
      'src/models/catalog.ts',
      'src/payload/sanitize.ts',
    ]) {
      expect(files).toContain(required);
    }
  });
});
