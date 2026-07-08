export function billingJsonResponse(
  monthlyLimit: unknown,
  used: unknown,
  billingPeriodEnd: unknown,
  status = 200,
) {
  return new Response(
    JSON.stringify({
      config: {
        monthlyLimit: { val: monthlyLimit },
        used: { val: used },
        billingPeriodEnd,
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

export function weeklyCreditsJsonResponse(
  creditUsagePercent: number,
  opts: {
    start?: string;
    end?: string;
    product?: string;
    productPercent?: number;
  } = {},
  status = 200,
) {
  const start = opts.start ?? '2026-07-06T02:01:23.459473+00:00';
  const end = opts.end ?? '2026-07-13T02:01:23.459473+00:00';
  return new Response(
    JSON.stringify({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start,
          end,
        },
        creditUsagePercent,
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        productUsage: [
          {
            product: opts.product ?? 'GrokBuild',
            usagePercent: opts.productPercent ?? creditUsagePercent,
          },
        ],
        isUnifiedBillingUser: true,
        prepaidBalance: { val: 0 },
        billingPeriodStart: start,
        billingPeriodEnd: end,
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}
