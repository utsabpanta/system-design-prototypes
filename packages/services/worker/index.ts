/**
 * Cell async plane.
 *
 * Drains the cell's own queue. Like the api handler it is bound to one cell,
 * so a backed-up or failing worker degrades exactly one cell's async
 * processing. Partial batch failures are reported per-message so one poison
 * task cannot force redelivery of its healthy batch-mates.
 */
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { ddbDoc } from '../../shared/aws.js';
import { applyFault } from '../../shared/faults.js';
import { MetricsRecorder } from '../../shared/metrics.js';
import { TaskRepository } from '../../shared/task-repository.js';
import { TenantContext } from '../../shared/tenant-context.js';
import type { TenantTier } from '../../shared/types.js';

const CELL_ID = process.env.CELL_ID ?? 'unknown-cell';
const TASKS_TABLE = process.env.TASKS_TABLE!;
const METRICS_TABLE = process.env.METRICS_TABLE!;

const metrics = new MetricsRecorder(ddbDoc(), METRICS_TABLE, `${CELL_ID}:worker`);

interface TaskMessage {
  tenantId: string;
  tenantTier?: TenantTier;
  taskId: string;
  durationMs?: number;
  /** Set by tests to force a failure and exercise the DLQ. */
  poison?: boolean;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      console.error(
        JSON.stringify({
          msg: 'task processing failed',
          cellId: CELL_ID,
          messageId: record.messageId,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

async function processRecord(record: SQSRecord): Promise<void> {
  const startedAt = Date.now();
  const msg = JSON.parse(record.body) as TaskMessage;
  const ctx = TenantContext.forSystem(msg.tenantId, msg.tenantTier ?? 'standard');
  const repo = new TaskRepository(ddbDoc(), TASKS_TABLE, ctx);

  try {
    // A faulted cell fails its async work too, not just its API — otherwise
    // the blast-radius test would only be exercising half the cell.
    await applyFault(CELL_ID);

    if (msg.poison) throw new Error('poison message (intentional)');

    await repo.updateStatus(msg.taskId, 'processing');
    await new Promise((r) => setTimeout(r, Math.min(msg.durationMs ?? 25, 5000)));
    await repo.updateStatus(msg.taskId, 'completed', {
      result: { processedBy: CELL_ID, processedAt: new Date().toISOString() },
    });

    await metrics.record({
      tenantId: msg.tenantId,
      latencyMs: Date.now() - startedAt,
      outcome: 'ok',
    });
  } catch (err) {
    await metrics.record({
      tenantId: msg.tenantId,
      latencyMs: Date.now() - startedAt,
      outcome: 'error',
    });
    // Best-effort status update; if the cell is truly down this also fails and
    // the message goes back for redelivery, which is the desired behaviour.
    await repo
      .updateStatus(msg.taskId, 'failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      .catch(() => undefined);
    throw err;
  }
}
