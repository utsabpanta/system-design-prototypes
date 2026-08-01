/**
 * Per-request, per-tenant scoped credentials — the AWS-native second layer of
 * pooled isolation behind TaskRepository.
 *
 * The cell's execution role can read the whole tasks table. Before touching
 * data we assume that same role again with a *session policy* that permits
 * only items whose partition key equals this tenant's. Even a handler bug that
 * hand-built a foreign key would be denied by IAM.
 *
 * Local caveat: LocalStack's free tier does not reliably evaluate session
 * policies (set ENFORCE_IAM=1 in docker-compose.yml to try). The code path and
 * the generated policy are exercised by unit tests regardless, so what runs
 * locally is the same thing that would be enforced on real AWS.
 */
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ddbDoc, scopedDdbDoc, stsClient } from './aws.js';
import type { TenantContext } from './tenant-context.js';

export interface ScopedPolicyInput {
  tableArn: string;
  leadingKey: string;
}

/** The session policy. Kept pure so tests can assert on it directly. */
export function buildSessionPolicy({ tableArn, leadingKey }: ScopedPolicyInput): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'TenantScopedItemAccess',
        Effect: 'Allow',
        Action: [
          'dynamodb:GetItem',
          'dynamodb:BatchGetItem',
          'dynamodb:Query',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
        ],
        Resource: [tableArn, `${tableArn}/index/*`],
        Condition: {
          'ForAllValues:StringEquals': {
            'dynamodb:LeadingKeys': [leadingKey],
          },
        },
      },
      {
        // Scans cannot be constrained by LeadingKeys, so they are simply gone.
        Sid: 'DenyTableWideScan',
        Effect: 'Deny',
        Action: ['dynamodb:Scan'],
        Resource: [tableArn, `${tableArn}/index/*`],
      },
    ],
  });
}

const CACHE_SKEW_MS = 60_000;
const cache = new Map<string, { client: DynamoDBDocumentClient; expiresAt: number }>();

/**
 * A DynamoDB client whose credentials cannot read outside this tenant.
 * Falls back to the ambient client if STS is unavailable — TaskRepository
 * still enforces scoping in code, so the request degrades to one layer
 * rather than failing. The fallback is logged so it is never silent.
 */
export async function tenantScopedDoc(
  ctx: TenantContext,
  opts: { roleArn?: string; tableArn?: string },
): Promise<DynamoDBDocumentClient> {
  const { roleArn, tableArn } = opts;
  if (!roleArn || !tableArn) return ddbDoc();

  const cached = cache.get(ctx.tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.client;

  try {
    const res = await stsClient().send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `tenant-${ctx.tenantId}`.slice(0, 64),
        DurationSeconds: 900,
        Policy: buildSessionPolicy({ tableArn, leadingKey: ctx.leadingKey }),
      }),
    );
    const c = res.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('no credentials returned');

    const client = scopedDdbDoc({
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
    });
    const expiresAt = (c.Expiration?.getTime() ?? Date.now() + 900_000) - CACHE_SKEW_MS;
    cache.set(ctx.tenantId, { client, expiresAt });
    return client;
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: 'scoped credential vending failed, falling back to execution role',
        tenantId: ctx.tenantId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return ddbDoc();
  }
}
