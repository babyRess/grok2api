import { getBaseUrl } from '../auth/oauth.js';

export type BillingPeriod = 'weekly' | 'monthly';

export type ProductUsageShare = {
  product: string;
  usagePercent: number;
};

/**
 * Monthly Grok Build credit pool from `GET /v1/billing`.
 * Weekly SuperGrok pool from `GET /v1/billing?format=credits`.
 */
export type BillingUsage = {
  period: BillingPeriod;
  label: string;
  /** Absolute credit units when available (monthly). */
  limit?: number;
  used?: number;
  remaining?: number;
  percentUsed: number;
  billingPeriodStart?: string;
  billingPeriodEnd: string;
  productUsage?: ProductUsageShare[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function moneyVal(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.val === 'number' && Number.isFinite(value.val) ? value.val : undefined;
}

function percentUsedFromRatio(used: number, limit: number) {
  if (limit <= 0) return 0;
  const raw = (used / limit) * 100;
  return raw < 1 ? Math.round(raw * 10) / 10 : Math.round(raw);
}

function normalizePercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return value < 1 && value > 0 ? Math.round(value * 10) / 10 : Math.round(value);
}

function billingHeaders() {
  return {
    authorization: '', // set by caller via wrapper — replaced below
    'x-xai-token-auth': 'xai-grok-cli',
    accept: 'application/json',
  };
}

async function fetchBillingJson(token: string, path: string) {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    headers: {
      ...billingHeaders(),
      authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) throw new Error(`billing endpoint returned ${response.status}`);
  return (await response.json()) as unknown;
}

export function parseMonthlyBillingUsage(payload: unknown): BillingUsage {
  if (!isRecord(payload)) throw new Error('invalid billing payload');
  const config = payload.config;
  if (!isRecord(config)) throw new Error('invalid billing payload');
  const monthlyLimit = moneyVal(config.monthlyLimit);
  const used = moneyVal(config.used);
  const billingPeriodEnd = config.billingPeriodEnd;
  const billingPeriodStart = config.billingPeriodStart;
  if (
    monthlyLimit === undefined ||
    used === undefined ||
    typeof billingPeriodEnd !== 'string' ||
    !Number.isFinite(new Date(billingPeriodEnd).getTime())
  ) {
    throw new Error('invalid billing payload');
  }
  return {
    period: 'monthly',
    label: 'Monthly credits',
    limit: monthlyLimit,
    used,
    remaining: Math.max(0, monthlyLimit - used),
    percentUsed: percentUsedFromRatio(used, monthlyLimit),
    ...(typeof billingPeriodStart === 'string' ? { billingPeriodStart } : {}),
    billingPeriodEnd,
  };
}

export function parseWeeklyCreditsUsage(payload: unknown): BillingUsage {
  if (!isRecord(payload)) throw new Error('invalid weekly credits payload');
  const config = payload.config;
  if (!isRecord(config)) throw new Error('invalid weekly credits payload');

  const percent =
    typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent)
      ? normalizePercent(config.creditUsagePercent)
      : undefined;

  const period = isRecord(config.currentPeriod) ? config.currentPeriod : undefined;
  const end =
    (typeof config.billingPeriodEnd === 'string' && config.billingPeriodEnd) ||
    (period && typeof period.end === 'string' ? period.end : undefined);
  const start =
    (typeof config.billingPeriodStart === 'string' && config.billingPeriodStart) ||
    (period && typeof period.start === 'string' ? period.start : undefined);

  if (percent === undefined || !end || !Number.isFinite(new Date(end).getTime())) {
    throw new Error('invalid weekly credits payload');
  }

  const productUsage = Array.isArray(config.productUsage)
    ? config.productUsage.flatMap((item): ProductUsageShare[] => {
        if (!isRecord(item) || typeof item.product !== 'string') return [];
        if (typeof item.usagePercent !== 'number' || !Number.isFinite(item.usagePercent)) return [];
        return [{ product: item.product, usagePercent: normalizePercent(item.usagePercent) }];
      })
    : undefined;

  return {
    period: 'weekly',
    label: 'Weekly SuperGrok Limit',
    percentUsed: percent,
    ...(start ? { billingPeriodStart: start } : {}),
    billingPeriodEnd: end,
    ...(productUsage?.length ? { productUsage } : {}),
  };
}

export async function fetchBillingUsage(token: string): Promise<BillingUsage> {
  return parseMonthlyBillingUsage(await fetchBillingJson(token, '/billing'));
}

export async function fetchWeeklyCreditsUsage(token: string): Promise<BillingUsage> {
  return parseWeeklyCreditsUsage(await fetchBillingJson(token, '/billing?format=credits'));
}

export async function fetchAllBillingUsage(token: string): Promise<{
  monthly?: BillingUsage;
  weekly?: BillingUsage;
  monthlyError?: string;
  weeklyError?: string;
}> {
  const [monthlyResult, weeklyResult] = await Promise.allSettled([
    fetchBillingUsage(token),
    fetchWeeklyCreditsUsage(token),
  ]);

  return {
    ...(monthlyResult.status === 'fulfilled'
      ? { monthly: monthlyResult.value }
      : {
          monthlyError:
            monthlyResult.reason instanceof Error
              ? monthlyResult.reason.message
              : String(monthlyResult.reason),
        }),
    ...(weeklyResult.status === 'fulfilled'
      ? { weekly: weeklyResult.value }
      : {
          weeklyError:
            weeklyResult.reason instanceof Error
              ? weeklyResult.reason.message
              : String(weeklyResult.reason),
        }),
  };
}

export function formatQuota(usage: BillingUsage | undefined) {
  if (!usage) {
    return [
      '  Usage:',
      '    billing data unavailable — try again, or run /connect grok-build if not yet authenticated',
    ];
  }

  const resetDate = new Date(new Date(usage.billingPeriodEnd).getTime() - 8 * 60 * 60 * 1000);
  const resetLabel = `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][resetDate.getUTCMonth()]} ${resetDate.getUTCDate()} ${resetDate.getUTCHours().toString().padStart(2, '0')}:${resetDate.getUTCMinutes().toString().padStart(2, '0')} PT`;

  if (usage.period === 'weekly') {
    const products = usage.productUsage
      ?.map((item) => `${item.product} ${item.usagePercent}%`)
      .join(', ');
    return [
      '  Weekly SuperGrok Limit:',
      `    ${usage.percentUsed}% used`,
      ...(products ? [`    Breakdown: ${products}`] : []),
      `    Resets at ${resetLabel}`,
    ];
  }

  return [
    '  Monthly credits:',
    `    ${usage.used?.toLocaleString()} / ${usage.limit?.toLocaleString()} credits used (${usage.percentUsed}%)`,
    `    ${usage.remaining?.toLocaleString()} credits remaining`,
    `    Resets at ${resetLabel}`,
  ];
}
