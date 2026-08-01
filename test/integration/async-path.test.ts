/**
 * The cell's async half: queue -> worker -> status transition, and what
 * happens to a message that can never succeed.
 */
import { describe, expect, it } from 'vitest';
import { GetQueueAttributesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqsClient } from '../../packages/shared/aws.js';
import { createTask, getCell, getTask, until } from '../helpers.js';
import type { Task } from '../../packages/shared/types.js';

describe('async processing', () => {
  it('carries a task from queued to completed without the caller waiting', async () => {
    const created = await createTask('acme', { kind: 'async-check', durationMs: 50 });
    expect(created.status).toBe(202);
    // The API returns before the work is done — that is the point of the queue.
    expect(created.task.status).toBe('queued');

    const final = await until(
      () => getTask('acme', created.task.taskId),
      (res) => (res.body as Task)?.status === 'completed',
      { timeoutMs: 45_000 },
    );

    const task = final.body as Task;
    expect(task.status).toBe('completed');
    expect((task.result as { processedBy: string }).processedBy).toBe(created.cellId);
  });

  it('processes the task inside the tenant\'s own cell', async () => {
    const created = await createTask('bigco', { kind: 'silo-async' });
    const final = await until(
      () => getTask('bigco', created.task.taskId),
      (res) => (res.body as Task)?.status === 'completed',
      { timeoutMs: 45_000 },
    );
    const task = final.body as Task;
    // The task never leaves the cell it was created in — no shared worker pool.
    expect((task.result as { processedBy: string }).processedBy).toBe(created.cellId);
    expect(task.cellId).toBe(created.cellId);
  });

  it('marks a task failed rather than losing it when processing throws', async () => {
    const cell = await getCell('cell-a', true);
    expect(cell).toBeDefined();

    // A task row with no matching queue message would just sit at "queued";
    // here the worker receives a message it cannot process and must record
    // the failure against the task instead of silently dropping it.
    const created = await createTask('acme', { kind: 'will-fail' });
    await sqsClient().send(
      new SendMessageCommand({
        QueueUrl: cell!.queueUrl,
        MessageBody: JSON.stringify({
          tenantId: 'acme',
          taskId: created.task.taskId,
          poison: true,
        }),
      }),
    );

    const final = await until(
      () => getTask('acme', created.task.taskId),
      (res) => (res.body as Task)?.status === 'failed',
      { timeoutMs: 60_000, intervalMs: 2000 },
    );
    const task = final.body as Task;
    expect(task.status).toBe('failed');
    expect(task.error).toContain('poison');
  });
});
