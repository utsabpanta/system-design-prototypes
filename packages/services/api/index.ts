/**
 * Cell data plane.
 *
 * Serves one cell's slice of the task API. It knows its own cell id and
 * nothing about any other cell — no cross-cell calls, no control-plane
 * dependency on the request path. The tenant arrives already resolved by the
 * router, and every data access goes through a TenantContext-bound repository.
 */
import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { ddbDoc, sqsClient } from '../../shared/aws.js';
import { applyFault, currentFault, InjectedFaultError } from '../../shared/faults.js';
import { BadRequestError, error, header, json, parseBody } from '../../shared/http.js';
import { MetricsRecorder } from '../../shared/metrics.js';
import { TaskRepository } from '../../shared/task-repository.js';
import { TenantAuthError, TenantContext } from '../../shared/tenant-context.js';
import { tenantScopedDoc } from '../../shared/tenant-credentials.js';
import type { Task } from '../../shared/types.js';

const CELL_ID = process.env.CELL_ID ?? 'unknown-cell';
const CELL_TIER = process.env.CELL_TIER ?? 'pooled';
const TASKS_TABLE = process.env.TASKS_TABLE!;
const TASKS_TABLE_ARN = process.env.TASKS_TABLE_ARN;
const METRICS_TABLE = process.env.METRICS_TABLE!;
const QUEUE_URL = process.env.TASKS_QUEUE_URL!;
const TENANT_ACCESS_ROLE_ARN = process.env.TENANT_ACCESS_ROLE_ARN;

const metrics = new MetricsRecorder(ddbDoc(), METRICS_TABLE, CELL_ID);

interface CreateTaskBody {
  kind?: string;
  payload?: unknown;
  /** Lets the load generator make work take a realistic amount of time. */
  durationMs?: number;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const startedAt = Date.now();
  const path = event.path ?? '/';
  const method = event.httpMethod ?? 'GET';
  let tenantId: string | undefined;
  let outcome: 'ok' | 'error' | 'throttled' = 'ok';

  try {
    // Health is answered even while the cell is faulted — that is how the
    // control plane learns the cell is sick instead of merely slow.
    if (path === '/health' || path === '/v1/health') {
      const fault = await currentFault(CELL_ID);
      return json(
        fault === 'none' ? 200 : 503,
        { cellId: CELL_ID, tier: CELL_TIER, fault, healthy: fault === 'none' },
        { cellId: CELL_ID },
      );
    }

    const ctx = TenantContext.fromHeaders(event.headers as Record<string, string | undefined>);
    tenantId = ctx.tenantId;

    await applyFault(CELL_ID);

    const doc = await tenantScopedDoc(ctx, {
      roleArn: TENANT_ACCESS_ROLE_ARN,
      tableArn: TASKS_TABLE_ARN,
    });
    const repo = new TaskRepository(doc, TASKS_TABLE, ctx);

    const readOnly = header(event.headers, 'x-tenant-status') === 'READ_ONLY';
    const taskId = /^\/v1\/tasks\/([^/]+)\/?$/.exec(path)?.[1];

    if (method === 'POST' && path === '/v1/tasks') {
      if (readOnly) {
        outcome = 'error';
        return error(
          409,
          'tenant_read_only',
          'tenant is migrating between cells; writes are paused',
          { cellId: CELL_ID, tenantId: ctx.tenantId },
        );
      }
      const body = parseBody<CreateTaskBody>(event.body, event.isBase64Encoded);
      const now = new Date().toISOString();
      const task: Task = {
        tenantId: ctx.tenantId,
        taskId: randomUUID(),
        status: 'queued',
        kind: body.kind ?? 'default',
        payload: body.payload ?? null,
        cellId: CELL_ID,
        createdAt: now,
        updatedAt: now,
      };
      await repo.put(task);
      await sqsClient().send(
        new SendMessageCommand({
          QueueUrl: QUEUE_URL,
          MessageBody: JSON.stringify({
            tenantId: ctx.tenantId,
            tenantTier: ctx.tier,
            taskId: task.taskId,
            durationMs: body.durationMs ?? 25,
          }),
        }),
      );
      return json(202, task, { cellId: CELL_ID, tenantId: ctx.tenantId });
    }

    if (method === 'GET' && taskId) {
      const task = await repo.get(taskId);
      if (!task) {
        // Deliberately 404, not 403: a tenant learns nothing about whether an
        // id exists in another tenant's partition.
        return error(404, 'not_found', `no task ${taskId}`, {
          cellId: CELL_ID,
          tenantId: ctx.tenantId,
        });
      }
      return json(200, task, { cellId: CELL_ID, tenantId: ctx.tenantId });
    }

    if (method === 'GET' && path === '/v1/tasks') {
      const limit = Number(event.queryStringParameters?.limit ?? 25);
      const page = await repo.list(Math.min(limit, 100), event.queryStringParameters?.cursor);
      return json(200, page, { cellId: CELL_ID, tenantId: ctx.tenantId });
    }

    outcome = 'error';
    return error(404, 'no_route', `${method} ${path}`, { cellId: CELL_ID, tenantId });
  } catch (err) {
    outcome = 'error';
    if (err instanceof TenantAuthError) {
      return error(401, 'unauthenticated', err.message, { cellId: CELL_ID });
    }
    if (err instanceof BadRequestError) {
      return error(400, 'bad_request', err.message, { cellId: CELL_ID, tenantId });
    }
    if (err instanceof InjectedFaultError) {
      return error(503, 'cell_unavailable', `cell ${CELL_ID} is degraded`, {
        cellId: CELL_ID,
        tenantId,
      });
    }
    console.error(JSON.stringify({ msg: 'unhandled', cellId: CELL_ID, tenantId, err: String(err) }));
    return error(500, 'internal', 'unexpected error', { cellId: CELL_ID, tenantId });
  } finally {
    await metrics.record({ tenantId, latencyMs: Date.now() - startedAt, outcome });
  }
};
