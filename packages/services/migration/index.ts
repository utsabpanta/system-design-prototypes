/**
 * Tenant migration task handlers, driven by a Step Functions state machine.
 *
 * Moving a live tenant between cells is the operation that justifies storing
 * an explicit tenant -> cell mapping instead of hashing. It is also the one
 * place where the cells' independence is deliberately crossed, so the steps
 * are ordered to keep the tenant's data correct at every intermediate point:
 *
 *   1. freeze      routing.status = READ_ONLY. Reads keep working; writes are
 *                  rejected with 409 at the router. This is the only moment of
 *                  user-visible impact, and it is bounded by the copy time.
 *   2. drain       wait for the source cell's queue to finish in-flight work,
 *                  so no worker writes to the source after the copy starts.
 *   3. copy        page the tenant's items from source to target.
 *   4. verify      compare counts. A mismatch aborts *before* cutover, so the
 *                  failure mode is "migration didn't happen", not "half the
 *                  tenant's data is missing".
 *   5. cutover     point routing at the target and set status ACTIVE.
 *   6. settle      wait out the router's route cache TTL so no warm instance
 *                  is still sending writes to the source.
 *   7. cleanup     delete the source copy, now that nothing reads it.
 *
 * Any failure before cutover routes to rollback, which restores ACTIVE on the
 * source. Cutover itself is a single-item write, which is the closest thing to
 * atomic available here — deliberately the last irreversible step.
 */
import {
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDoc, sqsClient } from '../../shared/aws.js';
import { getCell } from '../../shared/cell-directory.js';
import { TaskRepository } from '../../shared/task-repository.js';
import { TenantContext } from '../../shared/tenant-context.js';
import type { RoutingEntry, Task, TenantStatus } from '../../shared/types.js';

const ROUTING_TABLE = process.env.ROUTING_TABLE!;
const TENANTS_TABLE = process.env.TENANTS_TABLE!;
/** Must exceed the router's ROUTE_CACHE_TTL_MS so no warm instance is stale. */
const SETTLE_MS = Number(process.env.MIGRATION_SETTLE_MS ?? 8000);

const doc = ddbDoc();

export interface MigrationInput {
  tenantId: string;
  targetCellId: string;
  /** Set by the copy step so later steps do not re-resolve it. */
  sourceCellId?: string;
  copied?: number;
  /** Test hook: forces the copy step to throw so rollback can be exercised. */
  failAfterCopy?: boolean;
}

async function repoFor(tenantId: string, cellId: string): Promise<TaskRepository> {
  const cell = await getCell(cellId, true);
  if (!cell) throw new Error(`cell ${cellId} has no published config`);
  return new TaskRepository(doc, cell.tasksTable, TenantContext.forSystem(tenantId));
}

async function setRouting(
  tenantId: string,
  patch: { status?: TenantStatus; cellId?: string },
): Promise<RoutingEntry> {
  const sets = ['updatedAt = :now'];
  const values: Record<string, unknown> = { ':now': new Date().toISOString() };
  const names: Record<string, string> = {};

  if (patch.status) {
    sets.push('#status = :status');
    names['#status'] = 'status';
    values[':status'] = patch.status;
  }
  if (patch.cellId) {
    sets.push('cellId = :cellId');
    values[':cellId'] = patch.cellId;
  }

  const res = await doc.send(
    new UpdateCommand({
      TableName: ROUTING_TABLE,
      Key: { tenantId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(tenantId)',
      ReturnValues: 'ALL_NEW',
    }),
  );
  return res.Attributes as RoutingEntry;
}

/** Step 1: freeze writes and record where the tenant currently lives. */
export const freeze = async (input: MigrationInput): Promise<MigrationInput> => {
  const current = await doc.send(
    new GetCommand({ TableName: ROUTING_TABLE, Key: { tenantId: input.tenantId } }),
  );
  const route = current.Item as RoutingEntry | undefined;
  if (!route) throw new Error(`tenant ${input.tenantId} has no routing entry`);
  if (route.cellId === input.targetCellId) {
    throw new Error(`tenant ${input.tenantId} is already in ${input.targetCellId}`);
  }

  const target = await getCell(input.targetCellId, true);
  if (!target) throw new Error(`target cell ${input.targetCellId} does not exist`);

  await setRouting(input.tenantId, { status: 'READ_ONLY' });
  return { ...input, sourceCellId: route.cellId };
};

/** Step 2: let the source cell's queue finish, so nothing writes mid-copy. */
export const drain = async (input: MigrationInput): Promise<MigrationInput> => {
  const cell = await getCell(input.sourceCellId!, true);
  if (!cell) throw new Error(`source cell ${input.sourceCellId} has no config`);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await sqsClient().send(
      new GetQueueAttributesCommand({
        QueueUrl: cell.queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    const visible = Number(res.Attributes?.ApproximateNumberOfMessages ?? 0);
    const inFlight = Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
    if (visible + inFlight === 0) return input;
    await new Promise((r) => setTimeout(r, 2000));
  }

  // The queue is shared by every tenant in a pooled cell, so a busy neighbour
  // can keep it non-empty indefinitely. Proceeding is safe because the tenant
  // being migrated is already frozen and cannot enqueue anything new.
  console.warn(
    JSON.stringify({ msg: 'drain timed out; continuing', cellId: input.sourceCellId }),
  );
  return input;
};

/** Step 3: copy the tenant's items into the target cell. */
export const copy = async (input: MigrationInput): Promise<MigrationInput> => {
  const source = await repoFor(input.tenantId, input.sourceCellId!);
  const target = await repoFor(input.tenantId, input.targetCellId);

  let copied = 0;
  let cursor: string | undefined;
  do {
    const page = await source.list(100, cursor);
    for (const task of page.items) {
      await target.put(task);
      copied++;
    }
    cursor = page.cursor;
  } while (cursor);

  if (input.failAfterCopy) {
    throw new Error('injected failure after copy (rollback drill)');
  }

  return { ...input, copied };
};

/** Step 4: refuse to cut over unless the target really has the data. */
export const verify = async (input: MigrationInput): Promise<MigrationInput> => {
  const source = await repoFor(input.tenantId, input.sourceCellId!);
  const target = await repoFor(input.tenantId, input.targetCellId);

  const [sourceCount, targetCount] = await Promise.all([source.count(), target.count()]);
  if (targetCount < sourceCount) {
    throw new Error(
      `verification failed: source has ${sourceCount} items, target has ${targetCount}`,
    );
  }
  return input;
};

/** Step 5: the irreversible moment — one item write flips the tenant over. */
export const cutover = async (input: MigrationInput): Promise<MigrationInput> => {
  await setRouting(input.tenantId, { cellId: input.targetCellId, status: 'ACTIVE' });
  return input;
};

/** Step 6: outlast the router's cache before deleting anything. */
export const settle = async (input: MigrationInput): Promise<MigrationInput> => {
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  return input;
};

/** Step 7: drop the source copy and rebalance cell occupancy. */
export const cleanup = async (input: MigrationInput): Promise<MigrationInput> => {
  const source = await repoFor(input.tenantId, input.sourceCellId!);
  let cursor: string | undefined;
  do {
    const page = await source.list(100, cursor);
    for (const task of page.items) await source.delete(task.taskId);
    cursor = page.cursor;
  } while (cursor);

  await adjustOccupancy(input.sourceCellId!, -1);
  await adjustOccupancy(input.targetCellId, +1);
  return input;
};

/** Failure path: unfreeze the tenant where it already is. */
export const rollback = async (input: MigrationInput): Promise<MigrationInput> => {
  // Unfreeze first. Even if the cleanup below fails, the tenant must not be
  // left stuck in READ_ONLY — a stranded write freeze is a tenant outage,
  // whereas orphaned rows in a cell nobody routes to are merely untidy.
  await setRouting(input.tenantId, { status: 'ACTIVE' });

  // Remove whatever the aborted copy wrote into the target, so a retry starts
  // from an empty table rather than a half-populated one.
  //
  // This is unconditional. It used to be gated on sourceCellId being known,
  // which silently skipped the cleanup on exactly the failure it exists for:
  // the rollback payload does not carry sourceCellId (freeze may never have
  // set it), so the guard was always false and 191 orphaned rows survived a
  // rollback drill. The delete needs only the target and is safe either way —
  // the target is by definition a cell this tenant is not routed to, so it
  // holds nothing but this migration's leftovers, and an empty query is a
  // no-op when freeze failed before anything was copied.
  let deleted = 0;
  try {
    const target = await repoFor(input.tenantId, input.targetCellId);
    let cursor: string | undefined;
    do {
      const page = await target.list(100, cursor);
      for (const task of page.items) {
        await target.delete(task.taskId);
        deleted++;
      }
      cursor = page.cursor;
    } while (cursor);
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: 'target cleanup failed; orphaned rows may remain',
        tenantId: input.tenantId,
        targetCellId: input.targetCellId,
        deleted,
        err: String(err),
      }),
    );
  }

  console.log(
    JSON.stringify({ msg: 'rollback complete', tenantId: input.tenantId, deleted }),
  );
  return input;
};

const CELLS_TABLE = process.env.CELLS_TABLE!;

async function adjustOccupancy(cellId: string, delta: number): Promise<void> {
  await doc
    .send(
      new UpdateCommand({
        TableName: CELLS_TABLE,
        Key: { cellId },
        UpdateExpression: 'ADD tenantCount :delta',
        ExpressionAttributeValues: { ':delta': delta },
      }),
    )
    .catch((err) => console.warn(JSON.stringify({ msg: 'occupancy update failed', cellId, err: String(err) })));
}

/**
 * Every step returns the same fully-populated shape.
 *
 * Step Functions resolves each `$.field` in a task's payload eagerly, and a
 * path that is missing from the state is a hard error rather than a null. Since
 * JSON.stringify drops undefined keys, a step that simply spread its input
 * would silently delete optional fields and break the *next* state's payload.
 * Normalising here keeps that failure mode impossible.
 */
function normalize(input: MigrationInput): Required<MigrationInput> {
  return {
    tenantId: input.tenantId,
    targetCellId: input.targetCellId,
    sourceCellId: input.sourceCellId ?? '',
    copied: input.copied ?? 0,
    failAfterCopy: input.failAfterCopy ?? false,
  };
}

/** Single entry point; the state machine selects a step via `step`. */
export const handler = async (
  event: MigrationInput & { step: string },
): Promise<Required<MigrationInput>> => {
  const steps: Record<string, (i: MigrationInput) => Promise<MigrationInput>> = {
    freeze,
    drain,
    copy,
    verify,
    cutover,
    settle,
    cleanup,
    rollback,
  };
  const fn = steps[event.step];
  if (!fn) throw new Error(`unknown migration step '${event.step}'`);
  return normalize(await fn(normalize(event)));
};
