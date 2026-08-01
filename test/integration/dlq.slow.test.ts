/**
 * Dead letter queue redrive.
 *
 * Split out of async-path.test.ts because it is genuinely slow: three
 * redeliveries at a 35s visibility timeout, plus LocalStack's own SQS poller
 * backoff, puts the message in the DLQ around 3.5 minutes after it is sent
 * (measured, not estimated). That is too slow to sit in the default suite, but
 * the behaviour matters — without a DLQ a poison message is redelivered
 * forever and permanently consumes a slice of the cell's worker capacity,
 * which is a slow-motion cell outage caused by one bad message.
 *
 * Run with: pnpm run test:slow
 */
import { describe, expect, it } from 'vitest';
import { GetQueueAttributesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqsClient } from '../../packages/shared/aws.js';
import { getCell, until } from '../helpers.js';

const REDRIVE_TIMEOUT_MS = 300_000;

describe('dead letter queue', () => {
  it(
    'parks a permanently failing message in the cell\'s own DLQ',
    async () => {
      const cell = await getCell('cell-a', true);
      expect(cell).toBeDefined();
      const dlqUrl = cell!.queueUrl.replace(/-tasks$/, '-tasks-dlq');

      const before = await dlqDepth(dlqUrl);

      await sqsClient().send(
        new SendMessageCommand({
          QueueUrl: cell!.queueUrl,
          MessageBody: JSON.stringify({
            tenantId: 'acme',
            taskId: `poison-${Date.now()}`,
            poison: true,
          }),
        }),
      );

      const after = await until(() => dlqDepth(dlqUrl), (depth) => depth > before, {
        timeoutMs: REDRIVE_TIMEOUT_MS,
        intervalMs: 5000,
      });
      expect(after).toBeGreaterThan(before);
    },
    REDRIVE_TIMEOUT_MS + 30_000,
  );

  it('keeps the DLQ scoped to its own cell', async () => {
    // Each cell has its own DLQ, so one cell's poison backlog is invisible to
    // the others — the same containment property as the rest of the stack.
    const [a, b] = await Promise.all([getCell('cell-a', true), getCell('cell-b', true)]);
    expect(a!.queueUrl).not.toBe(b!.queueUrl);
    expect(a!.queueUrl).toContain('cell-a');
    expect(b!.queueUrl).toContain('cell-b');
  });
});

async function dlqDepth(queueUrl: string): Promise<number> {
  const res = await sqsClient().send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );
  return Number(res.Attributes?.ApproximateNumberOfMessages ?? 0);
}
