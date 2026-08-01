/**
 * The router does what a cell router must: send a tenant to its cell, every
 * time, and refuse anything it cannot place.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { call, cellOf, createTask, listCells, router, tenantHeaders } from '../helpers.js';

describe('cell routing', () => {
  let cellIds: string[];

  beforeAll(async () => {
    cellIds = (await listCells(true)).map((c) => c.cellId);
    expect(cellIds.length).toBeGreaterThanOrEqual(2);
  });

  it('answers its own health check without touching a cell', async () => {
    const res = await call<{ component: string; healthy: boolean }>(`${await router()}/health`);
    expect(res.status).toBe(200);
    expect(res.body.component).toBe('router');
  });

  it('routes a tenant to a real cell and stamps which one', async () => {
    const { status, cellId } = await createTask('acme');
    expect(status).toBe(202);
    expect(cellIds).toContain(cellId);
  });

  it('sends the same tenant to the same cell every time', async () => {
    const seen = new Set<string | null>();
    for (let i = 0; i < 3; i++) seen.add(await cellOf('acme'));
    expect(seen.size).toBe(1);
  });

  it('spreads standard tenants across more than one pooled cell', async () => {
    const placements = new Set<string | null>();
    for (const tenant of ['acme', 'globex', 'initech', 'umbrella']) {
      placements.add(await cellOf(tenant));
    }
    expect(placements.size).toBeGreaterThan(1);
  });

  it('gives the premium tenant a silo cell of its own', async () => {
    const cells = await listCells(true);
    const siloIds = cells.filter((c) => c.tier === 'silo').map((c) => c.cellId);
    expect(siloIds).toContain(await cellOf('bigco'));
  });

  it('never routes a standard tenant into the silo', async () => {
    const cells = await listCells(true);
    const siloIds = cells.filter((c) => c.tier === 'silo').map((c) => c.cellId);
    for (const tenant of ['acme', 'globex']) {
      expect(siloIds).not.toContain(await cellOf(tenant));
    }
  });

  it('rejects a tenant that was never onboarded', async () => {
    const res = await call<{ error: { code: string } }>(`${await router()}/v1/tasks`, {
      headers: tenantHeaders('ghost-corp'),
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('tenant_not_registered');
  });

  it('rejects an unauthenticated request before any lookup', async () => {
    const res = await call(`${await router()}/v1/tasks`);
    expect(res.status).toBe(401);
  });
});
