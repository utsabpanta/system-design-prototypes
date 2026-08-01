/** Shared plumbing for the integration suite. */
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import { ssmClient } from '../packages/shared/aws.js';
import { getCell, invalidateCellCache, listCells } from '../packages/shared/cell-directory.js';
import { adminEndpoint, call, routerEndpoint } from '../packages/shared/endpoints.js';
import { FAULT_CACHE_TTL_MS, faultParameterName } from '../packages/shared/faults.js';
import type { FaultMode, Task } from '../packages/shared/types.js';

export { call, getCell, listCells, invalidateCellCache };

let routerUrlCache: string | undefined;
let adminUrlCache: string | undefined;

export async function router(): Promise<string> {
  routerUrlCache ??= await routerEndpoint();
  return routerUrlCache;
}

export async function admin(): Promise<string> {
  adminUrlCache ??= await adminEndpoint();
  return adminUrlCache;
}

export function tenantHeaders(tenantId: string): Record<string, string> {
  return { 'x-tenant-id': tenantId };
}

export async function createTask(
  tenantId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; task: Task; cellId: string | null }> {
  const res = await call<Task>(`${await router()}/v1/tasks`, {
    method: 'POST',
    headers: tenantHeaders(tenantId),
    body: { kind: 'test', durationMs: 10, ...body },
  });
  return { status: res.status, task: res.body, cellId: res.headers.get('x-cell-id') };
}

export async function getTask(
  tenantId: string,
  taskId: string,
): Promise<{ status: number; body: unknown; cellId: string | null }> {
  const res = await call(`${await router()}/v1/tasks/${taskId}`, {
    headers: tenantHeaders(tenantId),
  });
  return { status: res.status, body: res.body, cellId: res.headers.get('x-cell-id') };
}

export async function cellOf(tenantId: string): Promise<string | null> {
  const res = await call(`${await router()}/v1/tasks?limit=1`, {
    headers: tenantHeaders(tenantId),
  });
  return res.headers.get('x-cell-id');
}

export async function setFault(cellId: string, mode: FaultMode): Promise<void> {
  await ssmClient().send(
    new PutParameterCommand({
      Name: faultParameterName(cellId),
      Value: mode,
      Type: 'String',
      Overwrite: true,
    }),
  );
  // Cell handlers cache the fault for FAULT_CACHE_TTL_MS; wait it out plus a
  // margin so a test never races the config propagating.
  await sleep(FAULT_CACHE_TTL_MS + 1500);
}

export async function clearAllFaults(): Promise<void> {
  const cells = await listCells(true);
  for (const c of cells) {
    await ssmClient().send(
      new PutParameterCommand({
        Name: faultParameterName(c.cellId),
        Value: 'none',
        Type: 'String',
        Overwrite: true,
      }),
    );
  }
  await sleep(FAULT_CACHE_TTL_MS + 1500);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls until predicate holds or the deadline passes. Returns the last value. */
export async function until<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 30_000, intervalMs = 1000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!predicate(last) && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

/**
 * Rate limits are per tenant and deliberately tight, so tests that only need
 * "a request happened" should pace themselves rather than fight the limiter.
 */
export async function paced<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (const item of items) {
    await fn(item);
    await sleep(210); // ~4.7 rps, just under the standard tier's 5
  }
}
