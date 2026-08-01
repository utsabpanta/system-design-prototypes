/**
 * Control-plane admin API.
 *
 * Onboarding, cell inventory, and the routing map. Everything here is
 * off the request path for tenant traffic — if this Lambda is down, existing
 * tenants keep being served by their cells; only changes to the topology stop.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DescribeExecutionCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { ddbDoc, sfnClient, sqsClient, ssmClient } from '../../shared/aws.js';
import { listCells } from '../../shared/cell-directory.js';
import { faultParameterName } from '../../shared/faults.js';
import { BadRequestError, error, json, parseBody } from '../../shared/http.js';
import { readBuckets } from '../../shared/metrics.js';
import { defaultRateLimit, NoCapacityError, placeTenant, type PlacementCandidate } from '../../shared/placement.js';
import type { CellRecord, FaultMode, RoutingEntry, Tenant, TenantTier } from '../../shared/types.js';

const TENANTS_TABLE = process.env.TENANTS_TABLE!;
const ROUTING_TABLE = process.env.ROUTING_TABLE!;
const CELLS_TABLE = process.env.CELLS_TABLE!;
const CP_METRICS_TABLE = process.env.METRICS_TABLE!;
const MIGRATION_STATE_MACHINE_ARN = process.env.MIGRATION_STATE_MACHINE_ARN!;

const doc = ddbDoc();

interface OnboardBody {
  tenantId?: string;
  name?: string;
  tier?: TenantTier;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod ?? 'GET';
  const path = (event.path ?? '/').replace(/\/$/, '') || '/';

  try {
    if (path === '/health' || path === '/admin/health') {
      return json(200, { component: 'admin', healthy: true });
    }

    if (method === 'POST' && path === '/admin/cells/sync') {
      return json(200, { cells: await syncCells() });
    }

    if (method === 'GET' && path === '/admin/cells') {
      return json(200, { cells: await readCellRecords() });
    }

    if (method === 'POST' && path === '/admin/tenants') {
      const body = parseBody<OnboardBody>(event.body, event.isBase64Encoded);
      if (!body.tenantId) return error(400, 'bad_request', 'tenantId is required');
      return await onboard(body);
    }

    if (method === 'GET' && path === '/admin/tenants') {
      const res = await doc.send(new ScanCommand({ TableName: TENANTS_TABLE }));
      return json(200, { tenants: (res.Items ?? []) as Tenant[] });
    }

    const tenantMatch = /^\/admin\/tenants\/([^/]+)$/.exec(path);
    if (method === 'GET' && tenantMatch) {
      const tenantId = tenantMatch[1];
      const [tenant, route] = await Promise.all([
        doc.send(new GetCommand({ TableName: TENANTS_TABLE, Key: { tenantId } })),
        doc.send(new GetCommand({ TableName: ROUTING_TABLE, Key: { tenantId } })),
      ]);
      if (!tenant.Item) return error(404, 'not_found', `no tenant ${tenantId}`);
      return json(200, { tenant: tenant.Item, routing: route.Item ?? null });
    }

    if (method === 'POST' && path === '/admin/migrations') {
      const body = parseBody<{
        tenantId?: string;
        targetCellId?: string;
        failAfterCopy?: boolean;
      }>(event.body, event.isBase64Encoded);
      if (!body.tenantId || !body.targetCellId) {
        return error(400, 'bad_request', 'tenantId and targetCellId are required');
      }
      // Seed every field the state machine references. Step Functions resolves
      // payload paths eagerly, so an absent key is a hard failure mid-run.
      const res = await sfnClient().send(
        new StartExecutionCommand({
          stateMachineArn: MIGRATION_STATE_MACHINE_ARN,
          input: JSON.stringify({
            tenantId: body.tenantId,
            targetCellId: body.targetCellId,
            sourceCellId: '',
            copied: 0,
            failAfterCopy: body.failAfterCopy ?? false,
          }),
        }),
      );
      return json(202, { executionArn: res.executionArn, startedAt: res.startDate });
    }

    if (method === 'GET' && path === '/admin/migrations') {
      const arn = event.queryStringParameters?.executionArn;
      if (!arn) return error(400, 'bad_request', 'executionArn query parameter is required');
      const res = await sfnClient().send(
        new DescribeExecutionCommand({ executionArn: arn }),
      );
      return json(200, {
        status: res.status,
        startedAt: res.startDate,
        stoppedAt: res.stopDate,
        output: res.output ? JSON.parse(res.output) : null,
        error: res.error ?? null,
        cause: res.cause ?? null,
      });
    }

    if (method === 'GET' && path === '/admin/overview') {
      return json(200, await overview());
    }

    if (method === 'GET' && path === '/admin/routing') {
      const res = await doc.send(new ScanCommand({ TableName: ROUTING_TABLE }));
      return json(200, { routes: (res.Items ?? []) as RoutingEntry[] });
    }

    return error(404, 'no_route', `${method} ${path}`);
  } catch (err) {
    if (err instanceof NoCapacityError) {
      return error(err.statusCode, 'no_capacity', err.message);
    }
    if (err instanceof BadRequestError) {
      return error(400, 'bad_request', err.message);
    }
    console.error(JSON.stringify({ msg: 'admin failure', err: String(err) }));
    return error(500, 'internal', err instanceof Error ? err.message : String(err));
  }
};

/**
 * Refresh cp-cells from what the cell stacks published to SSM. Deployment of a
 * cell is what creates it; this just teaches the control plane it exists.
 * tenantCount is preserved so a sync never loses occupancy data.
 */
async function syncCells(): Promise<CellRecord[]> {
  const configs = await listCells(true);
  const records: CellRecord[] = [];

  for (const cfg of configs) {
    const res = await doc.send(
      new UpdateCommand({
        TableName: CELLS_TABLE,
        Key: { cellId: cfg.cellId },
        UpdateExpression: [
          'SET #tier = :tier, #capacity = :capacity, #endpoint = :endpoint,',
          '#status = if_not_exists(#status, :active),',
          'tenantCount = if_not_exists(tenantCount, :zero)',
        ].join(' '),
        // capacity and status are DynamoDB reserved words.
        ExpressionAttributeNames: {
          '#tier': 'tier',
          '#status': 'status',
          '#capacity': 'capacity',
          '#endpoint': 'endpoint',
        },
        ExpressionAttributeValues: {
          ':tier': cfg.tier,
          ':capacity': cfg.capacity,
          ':endpoint': cfg.endpoint,
          ':active': 'ACTIVE',
          ':zero': 0,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    records.push(res.Attributes as CellRecord);
  }

  return records;
}

/**
 * Everything the dashboard needs, assembled by *pulling* from each cell.
 *
 * Cells never push telemetry to the control plane. Each one owns its metrics
 * table and its own fault switch, and this endpoint reads them on demand — so
 * a cell that is down simply reports as unreachable instead of taking the
 * overview with it, and a slow control plane never becomes a cell's problem.
 * Per-cell failures are caught individually for the same reason.
 */
async function overview(): Promise<Record<string, unknown>> {
  const [cells, routesRes, tenantsRes] = await Promise.all([
    listCells(true),
    doc.send(new ScanCommand({ TableName: ROUTING_TABLE })),
    doc.send(new ScanCommand({ TableName: TENANTS_TABLE })),
  ]);

  const routes = (routesRes.Items ?? []) as RoutingEntry[];
  const tenants = (tenantsRes.Items ?? []) as Tenant[];
  const tenantsByCell = new Map<string, RoutingEntry[]>();
  for (const r of routes) {
    tenantsByCell.set(r.cellId, [...(tenantsByCell.get(r.cellId) ?? []), r]);
  }

  const cellViews = await Promise.all(
    cells.map(async (cell) => {
      const [fault, metrics, queue] = await Promise.all([
        readFault(cell.cellId),
        readCellMetrics(cell).catch(() => null),
        readQueueDepth(cell.queueUrl).catch(() => null),
      ]);
      return {
        cellId: cell.cellId,
        tier: cell.tier,
        capacity: cell.capacity,
        endpoint: cell.endpoint,
        fault,
        healthy: fault === 'none',
        queue,
        metrics,
        tenants: (tenantsByCell.get(cell.cellId) ?? [])
          .map((r) => ({
            tenantId: r.tenantId,
            tier: r.tier,
            status: r.status,
            rateLimit: r.rateLimit,
          }))
          .sort((a, b) => a.tenantId.localeCompare(b.tenantId)),
      };
    }),
  );

  const routerMetrics = await readMetrics(CP_METRICS_TABLE, 'router').catch(() => null);

  return {
    generatedAt: new Date().toISOString(),
    router: routerMetrics,
    cells: cellViews,
    totals: {
      cells: cells.length,
      tenants: tenants.length,
      migrating: routes.filter((r) => r.status === 'READ_ONLY').length,
      unhealthyCells: cellViews.filter((c) => !c.healthy).length,
    },
  };
}

async function readFault(cellId: string): Promise<FaultMode> {
  try {
    const res = await ssmClient().send(
      new GetParameterCommand({ Name: faultParameterName(cellId) }),
    );
    return (res.Parameter?.Value as FaultMode) ?? 'none';
  } catch {
    return 'none';
  }
}

async function readQueueDepth(
  queueUrl: string,
): Promise<{ visible: number; inFlight: number; dlq: number }> {
  const attrs = async (url: string) => {
    const res = await sqsClient().send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return {
      visible: Number(res.Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  };
  const main = await attrs(queueUrl);
  const dlq = await attrs(queueUrl.replace(/-tasks$/, '-tasks-dlq')).catch(() => ({ visible: 0 }));
  return { ...main, dlq: dlq.visible };
}

function readCellMetrics(cell: { cellId: string; metricsTable: string }) {
  return readMetrics(cell.metricsTable, cell.cellId);
}

/** Rolls the last few minutes of per-minute buckets into one view. */
async function readMetrics(tableName: string, scope: string) {
  const buckets = await readBuckets(doc, tableName, scope, 5);
  const all = buckets.filter((b) => b.tenantId === '_all');
  const perTenant = buckets.filter((b) => b.tenantId !== '_all');

  const sum = (rows: typeof buckets, key: 'requests' | 'errors' | 'throttled' | 'latencySumMs') =>
    rows.reduce((n, b) => n + b[key], 0);

  const requests = sum(all, 'requests');
  const byTenant = new Map<string, { requests: number; errors: number; throttled: number }>();
  for (const b of perTenant) {
    const prev = byTenant.get(b.tenantId) ?? { requests: 0, errors: 0, throttled: 0 };
    byTenant.set(b.tenantId, {
      requests: prev.requests + b.requests,
      errors: prev.errors + b.errors,
      throttled: prev.throttled + b.throttled,
    });
  }

  return {
    windowMinutes: 5,
    requests,
    errors: sum(all, 'errors'),
    throttled: sum(all, 'throttled'),
    avgLatencyMs: requests ? Math.round(sum(all, 'latencySumMs') / requests) : 0,
    maxLatencyMs: all.reduce((m, b) => Math.max(m, b.latencyMaxMs), 0),
    byTenant: Object.fromEntries(byTenant),
  };
}

async function readCellRecords(): Promise<CellRecord[]> {
  const res = await doc.send(new ScanCommand({ TableName: CELLS_TABLE }));
  return ((res.Items ?? []) as CellRecord[]).sort((a, b) => a.cellId.localeCompare(b.cellId));
}

async function onboard(body: OnboardBody): Promise<APIGatewayProxyResult> {
  const tenantId = body.tenantId!;
  const tier: TenantTier = body.tier === 'premium' ? 'premium' : 'standard';

  const existing = await doc.send(
    new GetCommand({ TableName: TENANTS_TABLE, Key: { tenantId } }),
  );
  if (existing.Item) {
    // Idempotent in placement — re-onboarding must never assign a second cell,
    // because that would orphan the tenant's existing data. But entitlements
    // are reconciled from the current tier defaults, so re-running the seed
    // after changing a tier's limits actually applies them.
    const limit = defaultRateLimit(tier);
    await doc.send(
      new UpdateCommand({
        TableName: TENANTS_TABLE,
        Key: { tenantId },
        UpdateExpression: 'SET #tier = :tier, rateLimit = :limit',
        ExpressionAttributeNames: { '#tier': 'tier' },
        ExpressionAttributeValues: { ':tier': tier, ':limit': limit },
      }),
    );
    const route = await doc.send(
      new UpdateCommand({
        TableName: ROUTING_TABLE,
        Key: { tenantId },
        UpdateExpression: 'SET #tier = :tier, rateLimit = :limit, updatedAt = :now',
        ExpressionAttributeNames: { '#tier': 'tier' },
        ExpressionAttributeValues: {
          ':tier': tier,
          ':limit': limit,
          ':now': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return json(200, {
      tenant: { ...existing.Item, tier, rateLimit: limit },
      routing: route.Attributes ?? null,
      created: false,
    });
  }

  const cells = await readCellRecords();
  const candidates: PlacementCandidate[] = cells
    .filter((c) => c.status === 'ACTIVE')
    .map((c) => ({
      cellId: c.cellId,
      tier: c.tier,
      capacity: c.capacity,
      tenantCount: c.tenantCount ?? 0,
    }));

  // Claim a slot before writing the tenant. The conditional update is what
  // makes concurrent onboarding safe: two callers cannot both take the last
  // slot in a cell, and a loser simply retries against the next candidate.
  let claimed: PlacementCandidate | undefined;
  const remaining = [...candidates];
  while (!claimed) {
    const chosen = placeTenant(tier, remaining); // throws NoCapacityError when dry
    try {
      await doc.send(
        new UpdateCommand({
          TableName: CELLS_TABLE,
          Key: { cellId: chosen.cellId },
          UpdateExpression: 'ADD tenantCount :one',
          ConditionExpression: 'tenantCount < #capacity',
          ExpressionAttributeNames: { '#capacity': 'capacity' },
          ExpressionAttributeValues: { ':one': 1 },
        }),
      );
      claimed = chosen;
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      const idx = remaining.findIndex((c) => c.cellId === chosen.cellId);
      if (idx >= 0) remaining.splice(idx, 1);
    }
  }

  const now = new Date().toISOString();
  const rateLimit = defaultRateLimit(tier);

  const tenant: Tenant = {
    tenantId,
    name: body.name ?? tenantId,
    tier,
    status: 'ACTIVE',
    rateLimit,
    createdAt: now,
  };
  const routing: RoutingEntry = {
    tenantId,
    cellId: claimed.cellId,
    status: 'ACTIVE',
    tier,
    rateLimit,
    updatedAt: now,
  };

  await doc.send(new PutCommand({ TableName: TENANTS_TABLE, Item: tenant }));
  await doc.send(new PutCommand({ TableName: ROUTING_TABLE, Item: routing }));

  return json(201, { tenant, routing, created: true });
}
