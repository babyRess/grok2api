import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAllBillingUsage,
  fetchBillingUsage,
  fetchWeeklyCreditsUsage,
  formatQuota,
} from '../../src/opencode/billing.js';
import { billingJsonResponse, weeklyCreditsJsonResponse } from './billingTestHelpers.js';

describe('billing', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv('GROK_BUILD_BASE_URL', 'https://cli-chat-proxy.grok.com/v1');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('fetches monthly billing usage with the Grok Build token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      billingJsonResponse(4000, 1421, '2026-07-01T00:00:00+00:00'),
    );
    globalThis.fetch = fetchMock;

    const usage = await fetchBillingUsage('secret-token');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://cli-chat-proxy.grok.com/v1/billing');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer secret-token',
      'x-xai-token-auth': 'xai-grok-cli',
      accept: 'application/json',
    });
    expect(usage).toEqual({
      period: 'monthly',
      label: 'Monthly credits',
      limit: 4000,
      used: 1421,
      remaining: 2579,
      percentUsed: 36,
      billingPeriodEnd: '2026-07-01T00:00:00+00:00',
    });
  });

  it('fetches weekly SuperGrok credits usage', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => weeklyCreditsJsonResponse(5));
    globalThis.fetch = fetchMock;

    const usage = await fetchWeeklyCreditsUsage('secret-token');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    );
    expect(usage).toMatchObject({
      period: 'weekly',
      label: 'Weekly SuperGrok Limit',
      percentUsed: 5,
      billingPeriodEnd: '2026-07-13T02:01:23.459473+00:00',
      productUsage: [{ product: 'GrokBuild', usagePercent: 5 }],
    });
  });

  it('fetches weekly and monthly usage together', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('format=credits')) return weeklyCreditsJsonResponse(3);
      return billingJsonResponse(20000, 133, '2026-08-01T00:00:00+00:00');
    });

    const all = await fetchAllBillingUsage('token');
    expect(all.weekly?.percentUsed).toBe(3);
    expect(all.monthly?.percentUsed).toBe(0.7);
    expect(all.weeklyError).toBeUndefined();
    expect(all.monthlyError).toBeUndefined();
  });

  it('does not fetch billing when no token is available', async () => {
    const lines = formatQuota(undefined);
    expect(lines.join('\n')).toContain(
      'billing data unavailable — try again, or run /connect grok-build if not yet authenticated',
    );
  });

  it('rejects invalid billing payloads instead of returning NaN values', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingJsonResponse('4000', 1421, '2026-07-01T00:00:00+00:00'),
    );

    await expect(fetchBillingUsage('token')).rejects.toThrow('invalid billing payload');
    expect(formatQuota(undefined).join('\n')).toContain('billing data unavailable');
  });

  it('rejects invalid billing reset timestamps', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      billingJsonResponse(4000, 1421, 'not-a-date'),
    );

    await expect(fetchBillingUsage('token')).rejects.toThrow('invalid billing payload');
  });

  it('formats monthly credit usage and weekly super grok usage', async () => {
    const monthly = formatQuota({
      period: 'monthly',
      label: 'Monthly credits',
      limit: 4000,
      used: 1000,
      remaining: 3000,
      percentUsed: 25,
      billingPeriodEnd: '2026-07-01T00:00:00+00:00',
    });
    expect(monthly.join('\n')).toContain('1,000 / 4,000 credits used (25%)');
    expect(monthly.join('\n')).toContain('Monthly credits');

    const weekly = formatQuota({
      period: 'weekly',
      label: 'Weekly SuperGrok Limit',
      percentUsed: 3,
      billingPeriodEnd: '2026-07-13T02:01:23.459473+00:00',
      productUsage: [{ product: 'GrokBuild', usagePercent: 3 }],
    });
    expect(weekly.join('\n')).toContain('Weekly SuperGrok Limit');
    expect(weekly.join('\n')).toContain('3% used');
    expect(weekly.join('\n')).toContain('GrokBuild 3%');
  });
});
