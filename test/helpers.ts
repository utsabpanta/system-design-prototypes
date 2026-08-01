/** Shared plumbing for the integration suite. */
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import { ssmClient } from '../packages/shared/aws.js';
import { getCell, invalidateCellCache, listCells } from '../packages/shared/cell-directory.js';
import {
  adminEndpoint,
  call as callRaw,
  routerEndpoint,
  type ApiCallOptions,
  type ApiResponse,
} from '../packages/shared/endpoints.js';
import { FAULT_CACHE_TTL_MS, faultParameterName } from '../packages/shared/faults.js';
import { defaultRateLimit } from '../packages/shared/placement.js';
import type { FaultMode, Task } from '../packages/shared/types.js';

export { callRaw, getCell, listCells, invalidateCellCache };

/**
 * The default test client: identical to `callRaw`, except it waits out a 429
 * and retries.
 *
 * Rate limits here are deliberately tiny (2 rps for a standard tenant) so that
 * throttling is observable on a laptop. The side effect is that any test making
 * a few requests as one tenant trips the limiter — and then reports a
 * *throttle* as though it were an isolation or routing failure. That happened
 * twice while building this. Tests about semantics should not have to encode
 * the limiter's timing; they honour Retry-After and move on.
 *
 * Suites that are *about* the limiter must use `callRaw` to see the raw 429.
 */
export async function call<T = unknown>(
  url: string,
  opts: ApiCallOptions = {},
  attempts = 3,
): Promise<ApiResponse<T>> {
  let res = await callRaw<T>(url, opts);
  for (let i = 1; i < attempts && res.status === 429; i++) {
    const retryAfter = Number(res.headers.get('retry-after') ?? 1);
    await sleep(Math.max(250, retryAfter * 1000));
    res = await callRaw<T>(url, opts);
  }
  return res;
}

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
 * Gap a test must leave between two requests *from the same standard tenant*
 * to stay inside its budget.
 *
 * Derived from the real tier limit rather than hardcoded, because it silently
 * drifted once already: the pacing was written against a 5 rps budget, the tier
 * was later lowered to 2 rps, and a "victim" tenant started throttling itself —
 * which looked exactly like the noisy neighbour harming it.
 *
 * Probing several *different* tenants back to back needs no gap; buckets are
 * per tenant.
 */
export const STANDARD_TENANT_GAP_MS = Math.ceil(1000 / defaultRateLimit('standard').rps) + 200;
