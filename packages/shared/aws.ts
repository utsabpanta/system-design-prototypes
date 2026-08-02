/**
 * One place that decides where AWS calls go.
 *
 * Nothing else in the codebase reads AWS_ENDPOINT_URL. When the variable is
 * absent the clients point at real AWS, which is what makes the same source
 * deployable to a real account without edits.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SSMClient } from '@aws-sdk/client-ssm';
import { STSClient } from '@aws-sdk/client-sts';
import { SFNClient } from '@aws-sdk/client-sfn';

export const REGION = process.env.AWS_REGION ?? 'us-east-1';

/** Set locally (LocalStack), unset on real AWS. */
export const ENDPOINT = process.env.AWS_ENDPOINT_URL || undefined;

export const IS_LOCAL = Boolean(ENDPOINT);

function baseConfig() {
  return {
    region: REGION,
    ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
    // LocalStack accepts any credentials; outside Lambda the default chain has
    // nothing to find, so supply dummies rather than fail at client creation.
    ...(ENDPOINT && !process.env.AWS_LAMBDA_FUNCTION_NAME
      ? { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }
      : {}),
  };
}

let ddb: DynamoDBDocumentClient | undefined;
export function ddbDoc(): DynamoDBDocumentClient {
  ddb ??= DynamoDBDocumentClient.from(new DynamoDBClient(baseConfig()), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return ddb;
}

let sqs: SQSClient | undefined;
export function sqsClient(): SQSClient {
  sqs ??= new SQSClient(baseConfig());
  return sqs;
}

let ssm: SSMClient | undefined;
export function ssmClient(): SSMClient {
  ssm ??= new SSMClient(baseConfig());
  return ssm;
}

let sts: STSClient | undefined;
export function stsClient(): STSClient {
  sts ??= new STSClient(baseConfig());
  return sts;
}

let sfn: SFNClient | undefined;
export function sfnClient(): SFNClient {
  sfn ??= new SFNClient(baseConfig());
  return sfn;
}

/**
 * Build a DynamoDB document client from explicitly supplied credentials —
 * used by the per-tenant scoped-credential path in tenant-credentials.ts.
 */
export function scopedDdbDoc(credentials: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({ ...baseConfig(), credentials }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
}
