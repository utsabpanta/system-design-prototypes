/**
 * Noisy-neighbour containment.
 *
 * Blast-radius tests cover one cell *failing*. This covers one tenant
 * *succeeding too hard*: the abuser must absorb its own throttling while the
 * tenants sharing its cell carry on unaffected.
 *
 * Note the traffic shape. A token bucket is a limit on requests per second,
 * not on requests in flight, so the abuse here is rapid *serial* traffic
 * rather than a wide parallel fan-out. That tests the limiter honestly and
 * avoids drowning LocalStack, which runs one Docker container per invocation
 * (see packages/shared/concurrency.ts). The one place parallelism genuinely
 * matters — proving the limiter is atomic rather than racy — uses a bounded
 * fan-out through mapLimit.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mapLimit, rapidSerial } from '../../packages/shared/concurrency.js';
import {
  callRaw,
  cellOf,
  clearAllFaults,
  router,
  sleep,
  STANDARD_TENANT_GAP_MS,
  tenantHeaders,
} from '../helpers.js';

interface ProbeResult {
  status: number;
  latencyMs: number;
  retryAfter: string | null;
}

async function probe(tenantId: string): Promise<ProbeResult> {
  const startedAt = Date.now();
  const res = await callRaw(`${await router()}/v1/tasks?limit=1`, {
    headers: tenantHeaders(tenantId),
  });
  return {
    status: res.status,
    latencyMs: Date.now() - startedAt,
    retryAfter: res.headers.get('retry-after'),
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

describe('noisy neighbour containment', () => {
  let abuser: string;
  let victim: string;

  beforeAll(async () => {
    await clearAllFaults();

    // Two tenants that genuinely share a cell — otherwise the isolation being
    // demonstrated is just "they're in different cells", which is trivial.
    const byCell = new Map<string, string[]>();
    for (const t of ['acme', 'globex', 'initech', 'umbrella', 'hooli', 'soylent']) {
      const cell = (await cellOf(t)) ?? 'unknown';
      byCell.set(cell, [...(byCell.get(cell) ?? []), t]);
      await sleep(220);
    }
    const pair = [...byCell.values()].find((ts) => ts.length >= 2);
    expect(pair, 'need two tenants in one cell').toBeDefined();
    [abuser, victim] = pair!;
  });

  it('throttles a standard tenant that outruns its budget', async () => {
    // 30 back-to-back requests against rps=2, burst=5. Even at a leisurely
    // 200ms each this is ~5 rps sustained — well past the allowance.
    const results = await rapidSerial(30, () => probe(abuser));

    expect(results.filter((r) => r.status === 429).length).toBeGreaterThan(0);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThan(0);
    // Load shedding, not collapse: over-budget traffic is rejected cleanly.
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
  });

  it('returns a Retry-After the client can act on', async () => {
    const results = await rapidSerial(30, () => probe(abuser));
    const throttled = results.filter((r) => r.status === 429);
    expect(throttled.length).toBeGreaterThan(0);
    for (const r of throttled) {
      expect(Number(r.retryAfter)).toBeGreaterThan(0);
    }
  });

  it('stays correct under concurrent bursts rather than failing open', async () => {
    // The limiter is two conditional writes, not a read-modify-write, so
    // parallel callers cannot all lose a version race and be waved through.
    // An earlier optimistic-locking version failed exactly that way.
    await sleep(3000); // let the bucket refill so the burst starts full
    // 48 requests against burst=5 refilling 5 per 2.5s: even if the batch took
    // a full 10 seconds the budget could not exceed 25, so some must be shed.
    // Sizing it this way keeps the assertion deterministic rather than racing
    // the refill clock.
    // Fan-out comes from LOCAL_SAFE_CONCURRENCY (mapLimit's default) rather
    // than a literal, so CI can dial it down for a smaller runner. Hardcoding
    // it here would silently ignore that setting — which is exactly what the
    // env var exists to prevent.
    const results = await mapLimit(Array.from({ length: 48 }), () => probe(abuser));
    const statuses = results.map((r) => (r instanceof Error ? 0 : r.status));

    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    // Every request got a real verdict; none fell through to a server error.
    expect(statuses.filter((s) => s !== 200 && s !== 429)).toHaveLength(0);
  });

  it('leaves a co-tenant in the same cell unharmed during the abuse', async () => {
    const flood = rapidSerial(40, () => probe(abuser));

    // The victim must stay strictly inside its own budget, or it throttles
    // itself and the test blames the neighbour for it.
    const victimResults: ProbeResult[] = [];
    for (let i = 0; i < 6; i++) {
      victimResults.push(await probe(victim));
      await sleep(STANDARD_TENANT_GAP_MS);
    }
    await flood;

    expect(
      victimResults.filter((r) => r.status !== 200),
      `victim ${victim} should be unaffected by ${abuser}`,
    ).toHaveLength(0);
    expect(percentile(victimResults.map((r) => r.latencyMs), 95)).toBeLessThan(5000);
  });

  it('gives the premium tenant a budget the same traffic would not exhaust', async () => {
    await sleep(3000);
    const premium = await rapidSerial(30, () => probe('bigco'));
    const throttled = premium.filter((r) => r.status === 429).length;
    // Standard tier throttles on this exact traffic; premium (rps=50) does not.
    expect(throttled).toBe(0);
  });

  it('lets a throttled tenant recover once it backs off', async () => {
    await rapidSerial(30, () => probe(abuser));
    await sleep(3500); // bucket refills every burst/rps = 5/2 = 2.5s
    expect((await probe(abuser)).status).toBe(200);
  });
});
