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
    // Create the task and let its legitimate message finish first. Enqueuing
    // the poison message alongside the real one races two workers against the
    // same row, and whichever lands last wins — that flakiness is the test's,
    // not the system's.
    const created = await createTask('acme', { kind: 'will-fail' });
    await until(
      () => getTask('acme', created.task.taskId),
      (res) => (res.body as Task)?.status === 'completed',
      { timeoutMs: 45_000 },
    );

    // Resolve the tenant's *current* cell rather than assuming one: migration
    // tests move tenants around, and a hardcoded cell id sends the poison
    // message to a queue whose table does not hold this task.
    const cell = await getCell(created.cellId!, true);
    expect(cell, `no config for cell ${created.cellId}`).toBeDefined();

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

    // The worker must record the failure against the task rather than dropping
    // it silently — a task stuck at "completed" after a failed reprocess would
    // hide the error from the tenant entirely.
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
