/**
 * Cell router — the single front door.
 *
 * Deliberately thin. It resolves tenant -> cell, decides whether the request
 * is allowed through, and hands off. It holds no business logic, no per-cell
 * state, and never talks to a cell's database, because a fat router quietly
 * becomes the shared component that cell architecture exists to eliminate.
 *
 * Two modes, both real designs:
 *   proxy    - router forwards the request. One entry point, one hostname,
 *              but every request pays a hop and the router is on the critical
 *              path for all traffic.
 *   redirect - router answers 307 with the cell's own endpoint; the client
 *              then talks to the cell directly. Closer to how DNS- or
 *              CloudFront-based cell routing works on real AWS, and keeps the
 *              router out of the data path after the first request.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDoc } from '../../shared/aws.js';
import { getCell } from '../../shared/cell-directory.js';
import { error, json } from '../../shared/http.js';
import { MetricsRecorder } from '../../shared/metrics.js';
import { consumeToken } from '../../shared/rate-limiter.js';
import { TenantAuthError, TenantContext } from '../../shared/tenant-context.js';
import type { RoutingEntry } from '../../shared/types.js';

const ROUTING_TABLE = process.env.ROUTING_TABLE!;
const RATE_LIMIT_TABLE = process.env.RATE_LIMIT_TABLE!;
const METRICS_TABLE = process.env.METRICS_TABLE!;
const ROUTING_MODE = (process.env.ROUTING_MODE ?? 'proxy') as 'proxy' | 'redirect';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 10_000);
const ROUTE_CACHE_TTL_MS = Number(process.env.ROUTE_CACHE_TTL_MS ?? 5_000);

const metrics = new MetricsRecorder(ddbDoc(), METRICS_TABLE, 'router');

/**
 * Warm-instance cache of the routing map. The TTL is the reason a migration
 * cutover is not instant: it bounds how long stale routing can persist, and
 * the migration workflow waits it out before declaring the move complete.
 */
const routeCache = new Map<string, { entry: RoutingEntry | null; expiresAt: number }>();

async function lookupRoute(tenantId: string): Promise<RoutingEntry | null> {
  const hit = routeCache.get(tenantId);
  if (hit && hit.expiresAt > Date.now()) return hit.entry;

  const res = await ddbDoc().send(
    new GetCommand({ TableName: ROUTING_TABLE, Key: { tenantId } }),
  );
  const entry = (res.Item as RoutingEntry | undefined) ?? null;
  routeCache.set(tenantId, { entry, expiresAt: Date.now() + ROUTE_CACHE_TTL_MS });
  return entry;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const startedAt = Date.now();
  const method = event.httpMethod ?? 'GET';
  const path = event.path ?? '/';
  let tenantId: string | undefined;
  let outcome: 'ok' | 'error' | 'throttled' = 'ok';

  try {
    if (path === '/health') {
      return json(200, { component: 'router', mode: ROUTING_MODE, healthy: true });
    }

    const ctx = TenantContext.fromHeaders(event.headers as Record<string, string | undefined>);
    tenantId = ctx.tenantId;

    const route = await lookupRoute(ctx.tenantId);
    if (!route) {
      outcome = 'error';
      return error(404, 'tenant_not_registered', `no cell assigned to ${ctx.tenantId}`);
    }
    if (route.status === 'SUSPENDED') {
      outcome = 'error';
      return error(403, 'tenant_suspended', `tenant ${ctx.tenantId} is suspended`);
    }
    if (route.status === 'READ_ONLY' && WRITE_METHODS.has(method)) {
      outcome = 'error';
      return error(409, 'tenant_read_only', 'tenant is migrating; writes are paused', {
        tenantId: ctx.tenantId,
      });
    }

    // Throttle before resolving or calling the cell: a tenant over budget
    // should cost the cell nothing at all.
    const decision = await consumeToken(
      ddbDoc(),
      RATE_LIMIT_TABLE,
      route.tenantId,
      route.rateLimit ?? { rps: 5, burst: 10 },
    );
    if (!decision.allowed) {
      outcome = 'throttled';
      return error(429, 'rate_limited', `tenant ${route.tenantId} exceeded its request budget`, {
        tenantId: route.tenantId,
        cellId: route.cellId,
        headers: { 'retry-after': String(decision.retryAfterSeconds ?? 1) },
      });
    }

    const cell = await getCell(route.cellId);
    if (!cell) {
      outcome = 'error';
      return error(503, 'cell_unknown', `cell ${route.cellId} has no published config`);
    }

    const qs = event.queryStringParameters
      ? `?${new URLSearchParams(
          Object.entries(event.queryStringParameters).filter(
            (kv): kv is [string, string] => kv[1] != null,
          ),
        )}`
      : '';
    const target = `${cell.endpoint}${path}${qs}`;

    if (ROUTING_MODE === 'redirect') {
      return {
        statusCode: 307,
        headers: {
          location: target,
          'x-cell-id': cell.cellId,
          'x-tenant-id': ctx.tenantId,
          'x-routed-by': 'router',
        },
        body: '',
      };
    }

    // The router's own timeout is shorter than the cell's, so a wedged cell
    // consumes a router slot for a bounded time instead of until the platform
    // kills the invocation. Without this the blackhole fault would take the
    // router down with the cell.
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': route.tenantId,
          'x-tenant-tier': route.tier,
          'x-tenant-status': route.status,
        },
        body: WRITE_METHODS.has(method) && event.body ? event.body : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      outcome = 'error';
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      return error(
        timedOut ? 504 : 502,
        timedOut ? 'cell_timeout' : 'cell_unreachable',
        `cell ${cell.cellId}: ${err instanceof Error ? err.message : String(err)}`,
        { cellId: cell.cellId, tenantId: ctx.tenantId },
      );
    }

    const body = await upstream.text();
    if (upstream.status >= 500) outcome = 'error';

    return {
      statusCode: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'x-cell-id': cell.cellId,
        'x-tenant-id': ctx.tenantId,
        'x-routed-by': 'router',
      },
      body,
    };
  } catch (err) {
    outcome = 'error';
    if (err instanceof TenantAuthError) {
      return error(401, 'unauthenticated', err.message);
    }
    console.error(JSON.stringify({ msg: 'router failure', tenantId, err: String(err) }));
    return error(500, 'internal', 'router error');
  } finally {
    await metrics.record({ tenantId, latencyMs: Date.now() - startedAt, outcome });
  }
};
