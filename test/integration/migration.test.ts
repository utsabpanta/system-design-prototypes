/**
 * Live tenant migration between cells.
 *
 * The operation that justifies keeping an explicit tenant -> cell map rather
 * than hashing. What matters is not just that the tenant ends up elsewhere,
 * but what is true at every intermediate point: reads keep working, writes
 * fail loudly instead of landing in the wrong cell, no data is lost, and a
 * failure leaves the tenant exactly where it started.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDoc } from '../../packages/shared/aws.js';
import { admin, call, cellOf, createTask, getTask, listCells, router, sleep, tenantHeaders, until } from '../helpers.js';
import type { RoutingEntry, Task } from '../../packages/shared/types.js';

/** Reads the cell's table directly — the API only ever shows the routed cell. */
async function rowsInCell(cellId: string, tenantId: string): Promise<number> {
  const cells = await listCells(true);
  const cell = cells.find((c) => c.cellId === cellId);
  if (!cell) throw new Error(`no such cell ${cellId}`);
  const res = await ddbDoc().send(
    new QueryCommand({
      TableName: cell.tasksTable,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}` },
      Select: 'COUNT',
    }),
  );
  return res.Count ?? 0;
}

async function startMigration(
  tenantId: string,
  targetCellId: string,
  failAfterCopy = false,
): Promise<string> {
  const res = await call<{ executionArn: string }>(`${await admin()}/admin/migrations`, {
    method: 'POST',
    body: { tenantId, targetCellId, failAfterCopy },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return res.body.executionArn;
}

async function awaitMigration(arn: string): Promise<string> {
  const final = await until(
    () =>
      call<{ status: string }>(
        `${admin_}/admin/migrations?executionArn=${encodeURIComponent(arn)}`,
      ),
    (res) => res.body.status !== 'RUNNING',
    { timeoutMs: 240_000, intervalMs: 2000 },
  );
  return final.body.status;
}

let admin_: string;

/** The migration tenant is dedicated so other suites are unaffected by the move. */
const TENANT = 'initech';

describe('tenant migration', () => {
  let homeCell: string;
  let otherCell: string;

  beforeAll(async () => {
    admin_ = await admin();
    const cells = await listCells(true);
    const pooled = cells.filter((c) => c.tier === 'pooled').map((c) => c.cellId);
    expect(pooled.length, 'migration needs two pooled cells').toBeGreaterThanOrEqual(2);

    homeCell = (await cellOf(TENANT))!;
    otherCell = pooled.find((c) => c !== homeCell)!;
    expect(otherCell).toBeDefined();
  });

  afterAll(async () => {
    // Leave the tenant where the suite found it so reruns are deterministic.
    const now = await cellOf(TENANT);
    if (now && now !== homeCell) {
      await awaitMigration(await startMigration(TENANT, homeCell));
    }
  });

  it('moves a tenant and its data to the target cell', async () => {
    await createTask(TENANT, { kind: 'pre-migration' });
    await sleep(500);

    const before = await rowsInCell(homeCell, TENANT);
    expect(before).toBeGreaterThan(0);

    expect(await awaitMigration(await startMigration(TENANT, otherCell))).toBe('SUCCEEDED');

    expect(await cellOf(TENANT)).toBe(otherCell);
    expect(await rowsInCell(otherCell, TENANT)).toBeGreaterThanOrEqual(before);
    // The source copy is deleted only after the cutover has settled.
    expect(await rowsInCell(homeCell, TENANT)).toBe(0);
  });

  it('serves the tenant\'s pre-migration data from the new cell', async () => {
    const created = await createTask(TENANT, { kind: 'travels-with-tenant' });
    await sleep(500);
    const fromOld = created.cellId;

    const target = fromOld === homeCell ? otherCell : homeCell;
    expect(await awaitMigration(await startMigration(TENANT, target))).toBe('SUCCEEDED');

    const after = await getTask(TENANT, created.task.taskId);
    expect(after.status).toBe(200);
    expect(after.cellId).toBe(target);
    expect((after.body as Task).kind).toBe('travels-with-tenant');
  });

  it('leaves co-tenants in both cells untouched', async () => {
    const others = ['acme', 'globex', 'umbrella', 'hooli'].filter((t) => t !== TENANT);
    const before = new Map<string, string | null>();
    for (const t of others) {
      before.set(t, await cellOf(t));
      await sleep(220);
    }

    const current = (await cellOf(TENANT))!;
    const target = current === homeCell ? otherCell : homeCell;
    expect(await awaitMigration(await startMigration(TENANT, target))).toBe('SUCCEEDED');

    for (const t of others) {
      expect(await cellOf(t), `${t} must not be moved by another tenant's migration`).toBe(
        before.get(t),
      );
      await sleep(220);
    }
  });

  it('rejects a migration to the cell the tenant is already in', async () => {
    const current = (await cellOf(TENANT))!;
    expect(await awaitMigration(await startMigration(TENANT, current))).toBe('FAILED');
    // A no-op request must not have frozen the tenant on its way out.
    expect(await routingStatus(TENANT)).toBe('ACTIVE');
  });

  it('rolls back cleanly when a step fails, leaving no residue', async () => {
    const current = (await cellOf(TENANT))!;
    const target = current === homeCell ? otherCell : homeCell;

    const rowsBefore = await rowsInCell(current, TENANT);
    expect(await awaitMigration(await startMigration(TENANT, target, true))).toBe('FAILED');

    // Still served by the original cell, with its data intact...
    expect(await cellOf(TENANT)).toBe(current);
    expect(await rowsInCell(current, TENANT)).toBe(rowsBefore);
    // ...and the partial copy in the target has been removed. Skipping this
    // cleanup once left 191 orphaned rows behind a "successful" rollback.
    expect(await rowsInCell(target, TENANT)).toBe(0);
    // Writes must work again — a tenant stuck in READ_ONLY is an outage.
    expect(await routingStatus(TENANT)).toBe('ACTIVE');
    expect((await createTask(TENANT, { kind: 'post-rollback' })).status).toBe(202);
  });
});

async function routingStatus(tenantId: string): Promise<string> {
  const res = await call<{ routing: RoutingEntry | null }>(
    `${admin_}/admin/tenants/${tenantId}`,
  );
  return res.body.routing?.status ?? 'MISSING';
}
