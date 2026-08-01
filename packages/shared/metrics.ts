/**
 * Per-cell metrics, stored in the cell's own DynamoDB table.
 *
 * Deliberately cell-local: the control plane *pulls* metrics when the
 * dashboard asks, rather than cells pushing into a shared store. A cell must
 * not depend on the control plane to serve traffic, and a wedged control plane
 * must not become a cross-cell failure. On real AWS this would be CloudWatch
 * EMF; a DynamoDB counter table is the local stand-in that keeps that
 * ownership boundary visible.
 *
 * Rows are bucketed per minute:
 *   pk = <scope>            e.g. "cell-a" or "router"
 *   sk = <minute>#<tenant>  with "<minute>#_all" as the cell-wide rollup
 */
import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface MetricSample {
  tenantId?: string;
  latencyMs: number;
  outcome: 'ok' | 'error' | 'throttled';
}

export interface MetricBucket {
  scope: string;
  minute: string;
  tenantId: string;
  requests: number;
  errors: number;
  throttled: number;
  latencySumMs: number;
  latencyMaxMs: number;
}

const TTL_SECONDS = 60 * 60; // an hour of history is plenty for a demo

export function minuteBucket(at = new Date()): string {
  return at.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
}

export class MetricsRecorder {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly scope: string,
  ) {}

  /**
   * Records the sample against both the tenant row and the cell-wide rollup.
   * Failures are swallowed: telemetry must never fail a request.
   */
  async record(sample: MetricSample): Promise<void> {
    const minute = minuteBucket();
    const rows = ['_all', sample.tenantId].filter(Boolean) as string[];
    await Promise.all(rows.map((t) => this.bump(minute, t, sample).catch(() => undefined)));
  }

  private async bump(minute: string, tenantId: string, sample: MetricSample): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: this.scope, sk: `${minute}#${tenantId}` },
        UpdateExpression: [
          'ADD requests :one, errors :err, throttled :thr, latencySumMs :lat',
          'SET latencyMaxMs = if_not_exists(latencyMaxMs, :zero), expiresAt = :ttl',
        ].join(' '),
        ExpressionAttributeValues: {
          ':one': 1,
          ':err': sample.outcome === 'error' ? 1 : 0,
          ':thr': sample.outcome === 'throttled' ? 1 : 0,
          ':lat': Math.round(sample.latencyMs),
          ':zero': 0,
          ':ttl': Math.floor(Date.now() / 1000) + TTL_SECONDS,
        },
      }),
    );

    // Max is not expressible in an update expression; a conditional second
    // write keeps it correct without a read-modify-write race.
    await this.doc
      .send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: this.scope, sk: `${minute}#${tenantId}` },
          UpdateExpression: 'SET latencyMaxMs = :lat',
          ConditionExpression: 'latencyMaxMs < :lat',
          ExpressionAttributeValues: { ':lat': Math.round(sample.latencyMs) },
        }),
      )
      .catch(() => undefined);
  }
}

/** Reads recent buckets for a scope — used by the dashboard aggregator. */
export async function readBuckets(
  doc: DynamoDBDocumentClient,
  tableName: string,
  scope: string,
  sinceMinutes = 10,
): Promise<MetricBucket[]> {
  const from = minuteBucket(new Date(Date.now() - sinceMinutes * 60_000));
  const res = await doc.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND sk >= :from',
      ExpressionAttributeValues: { ':pk': scope, ':from': from },
    }),
  );
  return (res.Items ?? []).map((i) => {
    const [minute, tenantId] = String(i.sk).split('#');
    return {
      scope,
      minute,
      tenantId,
      requests: Number(i.requests ?? 0),
      errors: Number(i.errors ?? 0),
      throttled: Number(i.throttled ?? 0),
      latencySumMs: Number(i.latencySumMs ?? 0),
      latencyMaxMs: Number(i.latencyMaxMs ?? 0),
    };
  });
}
