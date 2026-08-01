/**
 * Control plane: the only component that knows the full cell inventory.
 *
 * It owns tenant identity, the tenant -> cell mapping, placement, rate-limit
 * state, and the migration workflow. It is deliberately off the critical path
 * for a cell's own request handling — a control plane outage must degrade
 * onboarding and routing changes, not running traffic.
 */
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import type { CellDefinition } from './cells.config.js';
import { localEndpointEnv, nodeFunction } from './lambda-defaults.js';

export interface ControlPlaneStackProps extends cdk.StackProps {
  cells: CellDefinition[];
  /**
   * proxy   - router forwards requests to the cell (single entry point)
   * redirect- router answers 307 and the client talks to the cell directly
   */
  routingMode?: 'proxy' | 'redirect';
}

export class ControlPlaneStack extends cdk.Stack {
  readonly tenantsTable: dynamodb.Table;
  readonly routingTable: dynamodb.Table;
  readonly cellsTable: dynamodb.Table;
  readonly rateLimitTable: dynamodb.Table;
  readonly metricsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('Component', 'control-plane');

    // Tenant identity and entitlements. Read rarely (onboarding, admin).
    this.tenantsTable = new dynamodb.Table(this, 'TenantsTable', {
      tableName: 'cp-tenants',
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // The routing map. Read on every single request, so it is its own table
    // rather than an attribute on the tenant record: different access pattern,
    // different throughput profile, and it can be cached far more aggressively.
    this.routingTable = new dynamodb.Table(this, 'RoutingTable', {
      tableName: 'cp-routing',
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Cell inventory and occupancy, used by the placement strategy.
    this.cellsTable = new dynamodb.Table(this, 'CellsTable', {
      tableName: 'cp-cells',
      partitionKey: { name: 'cellId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Token-bucket state, one row per tenant, expired by TTL when idle.
    this.rateLimitTable = new dynamodb.Table(this, 'RateLimitTable', {
      tableName: 'cp-ratelimit',
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // The router's own telemetry, same schema as each cell's metrics table.
    this.metricsTable = new dynamodb.Table(this, 'MetricsTable', {
      tableName: 'cp-metrics',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ------------------------------------------------------------- discovery
    // Read-only access to every cell's published coordinates. This is the only
    // link between the control plane and the cells, and it is one-directional.
    const readCellConfigs = new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      resources: [
        cdk.Arn.format({ service: 'ssm', resource: 'parameter', resourceName: 'cells/*' }, this),
      ],
    });

    // ---------------------------------------------------------------- router
    const routerFn = nodeFunction(this, 'RouterFunction', {
      functionName: 'cp-router',
      entry: 'packages/services/router/index.ts',
      timeout: cdk.Duration.seconds(29),
      environment: {
        ROUTING_TABLE: this.routingTable.tableName,
        RATE_LIMIT_TABLE: this.rateLimitTable.tableName,
        METRICS_TABLE: this.metricsTable.tableName,
        ROUTING_MODE: props.routingMode ?? 'proxy',
        ...localEndpointEnv(),
      },
    });
    this.routingTable.grantReadData(routerFn);
    this.rateLimitTable.grantReadWriteData(routerFn);
    this.metricsTable.grantReadWriteData(routerFn);
    routerFn.addToRolePolicy(readCellConfigs);

    const routerApi = new apigateway.LambdaRestApi(this, 'RouterApi', {
      restApiName: 'cp-router',
      handler: routerFn,
      proxy: true,
      deployOptions: { stageName: 'prod' },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowHeaders: ['content-type', 'x-tenant-id', 'x-tenant-tier'],
      },
    });

    // ----------------------------------------------------------------- admin
    const adminFn = nodeFunction(this, 'AdminFunction', {
      functionName: 'cp-admin',
      entry: 'packages/services/admin/index.ts',
      timeout: cdk.Duration.seconds(29),
      environment: {
        TENANTS_TABLE: this.tenantsTable.tableName,
        ROUTING_TABLE: this.routingTable.tableName,
        CELLS_TABLE: this.cellsTable.tableName,
        METRICS_TABLE: this.metricsTable.tableName,
        ...localEndpointEnv(),
      },
    });
    this.tenantsTable.grantReadWriteData(adminFn);
    this.routingTable.grantReadWriteData(adminFn);
    this.cellsTable.grantReadWriteData(adminFn);
    this.metricsTable.grantReadData(adminFn);
    adminFn.addToRolePolicy(readCellConfigs);

    // The overview endpoint pulls telemetry from each cell rather than having
    // cells push into a shared store, so it needs read access across cells.
    adminFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:GetItem'],
        resources: [
          cdk.Arn.format({ service: 'dynamodb', resource: 'table', resourceName: 'cell-*' }, this),
        ],
      }),
    );
    adminFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
        resources: [cdk.Arn.format({ service: 'sqs', resource: 'cell-*' }, this)],
      }),
    );

    const adminApi = new apigateway.LambdaRestApi(this, 'AdminApi', {
      restApiName: 'cp-admin',
      handler: adminFn,
      proxy: true,
      deployOptions: { stageName: 'prod' },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowHeaders: ['content-type'],
      },
    });

    // ------------------------------------------------------------- migration
    const migrationFn = nodeFunction(this, 'MigrationFunction', {
      functionName: 'cp-migration',
      entry: 'packages/services/migration/index.ts',
      // drain polls the source queue for up to a minute, and copy pages
      // through the tenant's items one at a time.
      timeout: cdk.Duration.minutes(5),
      environment: {
        ROUTING_TABLE: this.routingTable.tableName,
        TENANTS_TABLE: this.tenantsTable.tableName,
        CELLS_TABLE: this.cellsTable.tableName,
        ...localEndpointEnv(),
      },
    });
    this.routingTable.grantReadWriteData(migrationFn);
    this.tenantsTable.grantReadWriteData(migrationFn);
    this.cellsTable.grantReadWriteData(migrationFn);
    migrationFn.addToRolePolicy(readCellConfigs);

    // The migration Lambda is the one component that legitimately touches two
    // cells at once, so it gets explicit cross-cell data and queue access.
    migrationFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:DeleteItem',
          'dynamodb:Query',
          'dynamodb:UpdateItem',
        ],
        resources: [
          cdk.Arn.format({ service: 'dynamodb', resource: 'table', resourceName: 'cell-*' }, this),
        ],
      }),
    );
    migrationFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
        resources: [
          cdk.Arn.format({ service: 'sqs', resource: 'cell-*' }, this),
        ],
      }),
    );

    const step = (id: string, stepName: string): tasks.LambdaInvoke =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: migrationFn,
        payload: sfn.TaskInput.fromObject({
          'tenantId.$': '$.tenantId',
          'targetCellId.$': '$.targetCellId',
          'sourceCellId.$': "$.sourceCellId",
          'copied.$': '$.copied',
          'failAfterCopy.$': '$.failAfterCopy',
          step: stepName,
        }),
        // Replace the state with the handler's return value so each step sees
        // what the previous one produced (notably sourceCellId from freeze).
        outputPath: '$.Payload',
        retryOnServiceExceptions: true,
      });

    // No sourceCellId here: a failure inside freeze means the state never
    // gained that field, and referencing a missing path would fail the
    // rollback itself. The handler treats an absent source as "nothing copied".
    const rollbackState = new tasks.LambdaInvoke(this, 'Rollback', {
      lambdaFunction: migrationFn,
      payload: sfn.TaskInput.fromObject({
        'tenantId.$': '$.tenantId',
        'targetCellId.$': '$.targetCellId',
        step: 'rollback',
      }),
      outputPath: '$.Payload',
    }).next(new sfn.Fail(this, 'MigrationFailed', { cause: 'migration rolled back' }));

    const freezeState = step('Freeze', 'freeze');
    const drainState = step('Drain', 'drain');
    const copyState = step('Copy', 'copy');
    const verifyState = step('Verify', 'verify');
    const cutoverState = step('Cutover', 'cutover');
    const settleState = step('Settle', 'settle');
    const cleanupState = step('Cleanup', 'cleanup');

    // Everything up to and including verify can be safely undone, so those
    // steps fall back to rollback. After cutover the tenant is already live in
    // the target cell; cleanup failing there leaves stale rows behind, which
    // is untidy but harmless, and must NOT trigger a rollback.
    for (const s of [freezeState, drainState, copyState, verifyState]) {
      s.addCatch(rollbackState, { resultPath: '$.error' });
    }

    const definition = freezeState
      .next(drainState)
      .next(copyState)
      .next(verifyState)
      .next(cutoverState)
      .next(settleState)
      .next(cleanupState)
      .next(new sfn.Succeed(this, 'MigrationComplete'));

    const migrationMachine = new sfn.StateMachine(this, 'MigrationStateMachine', {
      stateMachineName: 'cp-tenant-migration',
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(30),
    });

    adminFn.addEnvironment('MIGRATION_STATE_MACHINE_ARN', migrationMachine.stateMachineArn);
    migrationMachine.grantStartExecution(adminFn);
    migrationMachine.grantRead(adminFn);

    const localUrl = (api: apigateway.RestApi) =>
      process.env.AWS_ENDPOINT_URL
        ? `http://${api.restApiId}.execute-api.localhost.localstack.cloud:4566/prod`
        : api.url.replace(/\/$/, '');

    // Published to SSM so tools and tests never need to parse stack outputs.
    new cdk.aws_ssm.StringParameter(this, 'RouterEndpointParameter', {
      parameterName: '/control-plane/router-endpoint',
      stringValue: localUrl(routerApi),
    });
    new cdk.aws_ssm.StringParameter(this, 'AdminEndpointParameter', {
      parameterName: '/control-plane/admin-endpoint',
      stringValue: localUrl(adminApi),
    });

    new cdk.CfnOutput(this, 'RouterEndpoint', { value: localUrl(routerApi) });
    new cdk.CfnOutput(this, 'AdminEndpoint', { value: localUrl(adminApi) });
    new cdk.CfnOutput(this, 'KnownCells', {
      value: props.cells.map((c) => `${c.id}:${c.tier}`).join(','),
    });
  }
}
