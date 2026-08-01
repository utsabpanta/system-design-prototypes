/**
 * Tenant-scoped data access for a single cell's tasks table.
 *
 * Note the API shape: no method takes a tenant id. The tenant is fixed at
 * construction from a TenantContext, so a handler holding a repository for
 * tenant A has no expressible way to read tenant B's items. That structural
 * property is the pooled-isolation story — the IAM session policy in
 * tenant-credentials.ts is the second layer behind it.
 */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { TenantContext } from './tenant-context.js';
import type { Task, TaskStatus } from './types.js';

export interface TaskPage {
  items: Task[];
  cursor?: string;
}

const SK_PREFIX = 'TASK#';

export class TaskRepository {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly ctx: TenantContext,
  ) {}

  private sk(taskId: string): string {
    return `${SK_PREFIX}${taskId}`;
  }

  private toTask(item: Record<string, unknown>): Task {
    const { pk: _pk, sk: _sk, ...rest } = item;
    return rest as unknown as Task;
  }

  async put(task: Task): Promise<void> {
    if (task.tenantId !== this.ctx.tenantId) {
      throw new Error('refusing to write a task belonging to another tenant');
    }
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: this.ctx.partitionKey, sk: this.sk(task.taskId), ...task },
      }),
    );
  }

  async get(taskId: string): Promise<Task | undefined> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: this.ctx.partitionKey, sk: this.sk(taskId) },
      }),
    );
    return res.Item ? this.toTask(res.Item) : undefined;
  }

  async list(limit = 25, cursor?: string): Promise<TaskPage> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': this.ctx.partitionKey, ':prefix': SK_PREFIX },
        Limit: limit,
        ExclusiveStartKey: cursor ? decodeCursor(cursor) : undefined,
        ScanIndexForward: false,
      }),
    );
    return {
      items: (res.Items ?? []).map((i) => this.toTask(i)),
      cursor: res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : undefined,
    };
  }

  async updateStatus(
    taskId: string,
    status: TaskStatus,
    extra: { result?: unknown; error?: string } = {},
  ): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: this.ctx.partitionKey, sk: this.sk(taskId) },
        UpdateExpression:
          'SET #status = :status, updatedAt = :now, #result = :result, #error = :error',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#result': 'result',
          '#error': 'error',
        },
        ExpressionAttributeValues: {
          ':status': status,
          ':now': new Date().toISOString(),
          ':result': extra.result ?? null,
          ':error': extra.error ?? null,
        },
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  }

  async delete(taskId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: this.ctx.partitionKey, sk: this.sk(taskId) },
      }),
    );
  }

  /** Migration + verification helper: every item for this tenant, paginated. */
  async scanTenant(limit = 100, cursor?: string): Promise<TaskPage> {
    return this.list(limit, cursor);
  }

  async count(): Promise<number> {
    let total = 0;
    let cursor: string | undefined;
    do {
      const page = await this.list(100, cursor);
      total += page.items.length;
      cursor = page.cursor;
    } while (cursor);
    return total;
  }
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeCursor(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}
