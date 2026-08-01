/**
 * The reason cell architecture exists.
 *
 * Break one cell completely, then assert that tenants in every other cell are
 * entirely unaffected. If this suite ever goes red, the cells have grown a
 * shared component and the design has quietly stopped working — which is
 * exactly the regression that is otherwise invisible until an outage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, cellOf, clearAllFaults, listCells, router, setFault, sleep, tenantHeaders } from '../helpers.js';

const TENANTS = ['acme', 'globex', 'initech', 'umbrella', 'hooli', 'soylent', 'bigco'];

/** tenant -> cell, resolved once so the tests can talk about victims vs bystanders. */
let placement: Map<string, string>;
let victimCell: string;
let victims: string[];
let bystanders: string[];

async function probe(tenantId: string): Promise<number> {
  const res = await call(`${await router()}/v1/tasks?limit=1`, {
    headers: tenantHeaders(tenantId),
  });
  return res.status;
}

/** Sequential, paced probes — a burst would trip the rate limiter and muddy the signal. */
async function probeAll(tenants: string[]): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  for (const t of tenants) {
    results.set(t, await probe(t));
    await sleep(220);
  }
  return results;
}

describe('blast radius containment', () => {
  beforeAll(async () => {
    await clearAllFaults();

    placement = new Map();
    for (const t of TENANTS) {
      const cell = await cellOf(t);
      if (cell) placement.set(t, cell);
      await sleep(220);
    }

    // Break the pooled cell holding the most tenants — the worst realistic case.
    const counts = new Map<string, number>();
    for (const [, cell] of placement) counts.set(cell, (counts.get(cell) ?? 0) + 1);
    const pooled = (await listCells(true)).filter((c) => c.tier === 'pooled').map((c) => c.cellId);
    victimCell = [...counts.entries()]
      .filter(([cell]) => pooled.includes(cell))
      .sort((a, b) => b[1] - a[1])[0][0];

    victims = [...placement].filter(([, c]) => c === victimCell).map(([t]) => t);
    bystanders = [...placement].filter(([, c]) => c !== victimCell).map(([t]) => t);

    expect(victims.length, 'need at least one tenant in the victim cell').toBeGreaterThan(0);
    expect(bystanders.length, 'need tenants outside the victim cell').toBeGreaterThan(0);
  });

  afterAll(async () => {
    await clearAllFaults();
  });

  it('is healthy everywhere before the fault', async () => {
    const results = await probeAll(TENANTS);
    for (const [tenant, status] of results) {
      expect(status, `${tenant} should be healthy pre-fault`).toBe(200);
    }
  });

  it('contains a hard cell failure to that cell alone', async () => {
    await setFault(victimCell, 'error');

    const victimResults = await probeAll(victims);
    const bystanderResults = await probeAll(bystanders);

    // The broken cell is genuinely broken — otherwise the test proves nothing.
    for (const [tenant, status] of victimResults) {
      expect(status, `${tenant} is in the failed cell ${victimCell}`).toBeGreaterThanOrEqual(500);
    }

    // And nobody else noticed. This is the entire claim of the architecture.
    for (const [tenant, status] of bystanderResults) {
      expect(status, `${tenant} shares no fate with ${victimCell}`).toBe(200);
    }
  });

  it('keeps the premium silo tenant serving through a pooled cell outage', async () => {
    await setFault(victimCell, 'error');
    expect(await probe('bigco')).toBe(200);
  });

  it('contains cell latency instead of spreading it', async () => {
    await setFault(victimCell, 'latency');

    const victim = victims[0];
    const bystander = bystanders[0];

    const victimStart = Date.now();
    await probe(victim);
    const victimMs = Date.now() - victimStart;

    await sleep(220);

    const bystanderStart = Date.now();
    const bystanderStatus = await probe(bystander);
    const bystanderMs = Date.now() - bystanderStart;

    expect(victimMs, 'the faulted cell should be visibly slow').toBeGreaterThan(1000);
    expect(bystanderStatus).toBe(200);
    expect(bystanderMs, 'a healthy cell must not inherit the slowdown').toBeLessThan(1000);
  });

  it('recovers the failed cell without redeploying anything', async () => {
    await setFault(victimCell, 'error');
    expect(await probe(victims[0])).toBeGreaterThanOrEqual(500);

    await setFault(victimCell, 'none');
    const results = await probeAll(TENANTS);
    for (const [tenant, status] of results) {
      expect(status, `${tenant} should be healthy after recovery`).toBe(200);
    }
  });
});
