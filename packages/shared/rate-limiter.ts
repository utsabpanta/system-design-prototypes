/**
 * Per-tenant token bucket, stored in DynamoDB.
 *
 * This is the noisy-neighbour control. A cell bounds the blast radius of a
 * *failure*; a rate limit bounds the blast radius of *success* — one tenant
 * discovering a for-loop should not consume the capacity of everyone sharing
 * its cell.
 *
 * ## Why this shape
 *
 * The obvious implementation — read the bucket, compute a continuous refill
 * from elapsed time, write it back under a version check — does not survive
 * contact with a burst. Every concurrent request reads the same version, one
 * write wins, the rest fail the condition and retry into the same wall. At
 * thirty concurrent requests essentially all of them exhaust their retries,
 * and a limiter that gives up under load is worse than no limiter: it is
 * precisely the burst it exists to stop that defeats it. (Measured, not
 * theorised — the first version of this file behaved exactly that way.)
 *
 * So there is no read-modify-write here. Two conditional writes, each atomic
 * on its own, and DynamoDB does the serialising:
 *
 *   1. `ADD tokens -1` conditional on `tokens >= 1`. Fully atomic — succeeds
 *      or fails, never contends. This is the common path.
 *   2. If that fails, try to refill: set the bucket back to full conditional
 *      on a whole refill interval having elapsed. Exactly one concurrent
 *      caller wins the refill; the losers are simply throttled.
 *
 * The cost is that refill is stepwise rather than continuous: the bucket
 * refills every `burst / rps` seconds instead of trickling. The long-run rate
 * is still `rps`; the shape is a sawtooth rather than a smooth line. That is a
 * fair trade for a limiter that cannot be defeated by concurrency, and it is
 * roughly what a real distributed limiter does anyway.
 */
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { RateLimit } from './types.js';

const IDLE_TTL_SECONDS = 3600;

export interface RateLimitDecision {
  allowed: boolean;
  /** Tokens left after this request, or -1 when not known. */
  remaining: number;
  retryAfterSeconds?: number;
}

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

export function refillIntervalMs(limit: RateLimit): number {
  return Math.max(1, Math.round((limit.burst / limit.rps) * 1000));
}

export async function consumeToken(
  doc: DynamoDBDocumentClient,
  tableName: string,
  tenantId: string,
  limit: RateLimit,
  now = Date.now(),
): Promise<RateLimitDecision> {
  const ttl = Math.floor(now / 1000) + IDLE_TTL_SECONDS;

  // 1. Fast path: spend a token. Atomic, so a hundred concurrent callers
  //    produce a hundred correctly ordered decisions and zero retries.
  try {
    const res = await doc.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { tenantId },
        UpdateExpression: 'ADD tokens :minusOne SET expiresAt = :ttl',
        ConditionExpression: 'tokens >= :one',
        ExpressionAttributeValues: { ':minusOne': -1, ':one': 1, ':ttl': ttl },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return { allowed: true, remaining: Number(res.Attributes?.tokens ?? 0) };
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
  }

  // 2. Empty (or brand new). Refill if a full interval has passed. Exactly one
  //    caller can win this write; everyone else falls through to throttled.
  const interval = refillIntervalMs(limit);
  try {
    await doc.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { tenantId },
        UpdateExpression: 'SET tokens = :refilled, lastRefillMs = :now, expiresAt = :ttl',
        ConditionExpression:
          'attribute_not_exists(tenantId) OR lastRefillMs <= :cutoff',
        ExpressionAttributeValues: {
          ':refilled': limit.burst - 1,
          ':now': now,
          ':cutoff': now - interval,
          ':ttl': ttl,
        },
      }),
    );
    return { allowed: true, remaining: limit.burst - 1 };
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
  }

  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil(interval / 1000)),
  };
}
