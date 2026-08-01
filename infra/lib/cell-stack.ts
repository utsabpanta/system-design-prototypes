/**
 * A cell: one complete, self-sufficient copy of the data plane.
 *
 * Everything a tenant's request touches lives inside this stack — API, compute,
 * table, queue, telemetry. There are no CloudFormation exports and no imports
 * from other cells or from the control plane, so `cdklocal deploy Cell-a`
 * cannot affect Cell-b and a failure in one cell has no shared component to
 * propagate through. Discovery happens at runtime through SSM instead of at
 * synth time through cross-stack references, precisely to keep it that way.
 */
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { cellConfigParameter, type CellDefinition } from './cells.config.js';
import { LAMBDA_DEFAULTS, localEndpointEnv, nodeFunction } from './lambda-defaults.js';

export interface CellStackProps extends cdk.StackProps {
  cell: CellDefinition;
}

export class CellStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CellStackProps) {
    super(scope, id, props);

    const { cell } = props;
    cdk.Tags.of(this).add('CellId', cell.id);
    cdk.Tags.of(this).add('CellTier', cell.tier);

    // ---------------------------------------------------------------- data
    const tasksTable = new dynamodb.Table(this, 'TasksTable', {
      tableName: `${cell.id}-tasks`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const metricsTable = new dynamodb.Table(this, 'MetricsTable', {
      tableName: `${cell.id}-metrics`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ------------------------------------------------------------- queueing
    const dlq = new sqs.Queue(this, 'TasksDlq', {
      queueName: `${cell.id}-tasks-dlq`,
      retentionPeriod: cdk.Duration.days(4),
    });

    const queue = new sqs.Queue(this, 'TasksQueue', {
      queueName: `${cell.id}-tasks`,
      // Must be at least the worker's timeout (30s) or a slow-but-succeeding
      // task gets redelivered while still running. Kept just above it so a
      // poison message reaches the DLQ in ~90s rather than ~3 minutes, which
      // keeps the redrive path testable in a reasonable time.
      visibilityTimeout: cdk.Duration.seconds(35),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // --------------------------------------------- per-tenant scoped access
    // Assumed per request with a session policy pinned to the caller's
    // partition key. AccountRootPrincipal (rather than the api function's own
    // role) avoids a synth-time cycle between the role and the function env.
    const tenantAccessRole = new iam.Role(this, 'TenantAccessRole', {
      roleName: `${cell.id}-tenant-access`,
      assumedBy: new iam.AccountRootPrincipal(),
      maxSessionDuration: cdk.Duration.hours(1),
      description: `Assumed by ${cell.id} handlers with a per-tenant session policy`,
    });
    tasksTable.grantReadWriteData(tenantAccessRole);

    // --------------------------------------------------------------- compute
    const commonEnv = {
      CELL_ID: cell.id,
      CELL_TIER: cell.tier,
      TASKS_TABLE: tasksTable.tableName,
      TASKS_TABLE_ARN: tasksTable.tableArn,
      METRICS_TABLE: metricsTable.tableName,
      TASKS_QUEUE_URL: queue.queueUrl,
      TENANT_ACCESS_ROLE_ARN: tenantAccessRole.roleArn,
      ...localEndpointEnv(),
    };

    const apiFn = nodeFunction(this, 'ApiFunction', {
      functionName: `${cell.id}-api`,
      entry: 'packages/services/api/index.ts',
      environment: commonEnv,
      timeout: cdk.Duration.seconds(29),
      reservedConcurrentExecutions: cell.reservedConcurrency,
    });

    const workerFn = nodeFunction(this, 'WorkerFunction', {
      functionName: `${cell.id}-worker`,
      entry: 'packages/services/worker/index.ts',
      environment: commonEnv,
      timeout: cdk.Duration.seconds(30),
    });

    tasksTable.grantReadWriteData(apiFn);
    tasksTable.grantReadWriteData(workerFn);
    metricsTable.grantReadWriteData(apiFn);
    metricsTable.grantReadWriteData(workerFn);
    queue.grantSendMessages(apiFn);
    queue.grantConsumeMessages(workerFn);
    tenantAccessRole.grantAssumeRole(apiFn.grantPrincipal);

    // Both handlers read their cell's fault switch.
    const faultParamArn = cdk.Arn.format(
      { service: 'ssm', resource: 'parameter', resourceName: `cells/${cell.id}/*` },
      this,
    );
    const readFault = new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [faultParamArn],
    });
    apiFn.addToRolePolicy(readFault);
    workerFn.addToRolePolicy(readFault);

    workerFn.addEventSource(new SqsEventSource(queue, { batchSize: 5, reportBatchItemFailures: true }));

    // ------------------------------------------------------------------ api
    const api = new apigateway.LambdaRestApi(this, 'Api', {
      restApiName: `${cell.id}-api`,
      handler: apiFn,
      proxy: true,
      deployOptions: { stageName: 'prod' },
      // The router is the only intended caller, but leaving the cell API
      // directly reachable is what makes `redirect` routing mode possible.
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowHeaders: ['content-type', 'x-tenant-id', 'x-tenant-tier'],
      },
    });

    // ------------------------------------------------ runtime discovery + chaos
    const endpoint = LAMBDA_DEFAULTS.isLocal
      ? `http://${api.restApiId}.execute-api.localhost.localstack.cloud:4566/prod`
      : api.url.replace(/\/$/, '');

    new ssm.StringParameter(this, 'CellConfigParameter', {
      parameterName: cellConfigParameter(cell.id),
      stringValue: this.toJsonString({
        cellId: cell.id,
        tier: cell.tier,
        capacity: cell.capacity,
        endpoint,
        tasksTable: tasksTable.tableName,
        metricsTable: metricsTable.tableName,
        queueUrl: queue.queueUrl,
      }),
    });

    new ssm.StringParameter(this, 'FaultParameter', {
      parameterName: `/cells/${cell.id}/fault`,
      stringValue: 'none',
    });

    new cdk.CfnOutput(this, 'CellEndpoint', { value: endpoint });
    new cdk.CfnOutput(this, 'TasksTableName', { value: tasksTable.tableName });
    new cdk.CfnOutput(this, 'MetricsTableName', { value: metricsTable.tableName });
    new cdk.CfnOutput(this, 'TasksQueueUrl', { value: queue.queueUrl });
  }
}
