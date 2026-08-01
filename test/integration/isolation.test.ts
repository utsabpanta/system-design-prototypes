/**
 * Pooled-tenant isolation.
 *
 * The interesting cases are between two tenants that share a cell — same
 * table, same queue, same Lambda. Tenants in different cells are isolated by
 * construction and prove nothing.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { call, cellOf, createTask, getTask, router, tenantHeaders } from '../helpers.js';
import type { Task } from '../../packages/shared/types.js';

describe('tenant isolation within a shared cell', () => {
  let coTenants: [string, string];
  let victimTaskId: string;

  beforeAll(async () => {
    // Find two seeded tenants that actually landed in the same pooled cell.
    const candidates = ['acme', 'globex', 'initech', 'umbrella', 'hooli', 'soylent'];
    const byCell = new Map<string, string[]>();
    for (const t of candidates) {
      const cell = (await cellOf(t)) ?? 'unknown';
      byCell.set(cell, [...(byCell.get(cell) ?? []), t]);
    }
    const pair = [...byCell.values()].find((ts) => ts.length >= 2);
    expect(pair, 'need two tenants sharing a cell to test pooled isolation').toBeDefined();
    coTenants = [pair![0], pair![1]];

    const created = await createTask(coTenants[0], { kind: 'secret' });
    expect(created.status).toBe(202);
    victimTaskId = created.task.taskId;
  });

  it('places both test tenants in the same cell', async () => {
    expect(await cellOf(coTenants[0])).toBe(await cellOf(coTenants[1]));
  });

  it('refuses a cross-tenant read of a known task id', async () => {
    const res = await getTask(coTenants[1], victimTaskId);
    expect(res.status).toBe(404);
  });

  it('does not leak existence: unknown and forbidden ids look identical', async () => {
    const forbidden = await getTask(coTenants[1], victimTaskId);
    const nonexistent = await getTask(coTenants[1], '00000000-0000-4000-8000-000000000000');
    expect(forbidden.status).toBe(nonexistent.status);
    expect(JSON.stringify(forbidden.body)).toBe(
      JSON.stringify(nonexistent.body).replace(
        '00000000-0000-4000-8000-000000000000',
        victimTaskId,
      ),
    );
  });

  it('scopes list results to the calling tenant only', async () => {
    const res = await call<{ items: Task[] }>(`${await router()}/v1/tasks?limit=100`, {
      headers: tenantHeaders(coTenants[1]),
    });
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.tenantId).toBe(coTenants[1]);
    }
  });

  it('lets the owning tenant read its own task', async () => {
    const res = await getTask(coTenants[0], victimTaskId);
    expect(res.status).toBe(200);
    expect((res.body as Task).taskId).toBe(victimTaskId);
  });

  it('rejects a malformed tenant id instead of treating it as a partition', async () => {
    const res = await call(`${await router()}/v1/tasks`, {
      headers: { 'x-tenant-id': 'TENANT#acme' },
    });
    expect(res.status).toBe(401);
  });
});
