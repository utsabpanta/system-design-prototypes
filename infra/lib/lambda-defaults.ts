/**
 * Shared Lambda wiring so every function in every stack is built identically.
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat, type NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../..');

export const LAMBDA_DEFAULTS = {
  /** True when deploying to LocalStack rather than a real account. */
  isLocal: Boolean(process.env.AWS_ENDPOINT_URL),
  runtime: lambda.Runtime.NODEJS_22_X,
};

/**
 * Lambdas reach AWS through LocalStack's in-container DNS name, not
 * localhost:4566 — inside a Lambda container, localhost is the container.
 * On real AWS this returns nothing and the SDK uses the public endpoints.
 */
export function localEndpointEnv(): Record<string, string> {
  return LAMBDA_DEFAULTS.isLocal
    ? { AWS_ENDPOINT_URL: 'http://localhost.localstack.cloud:4566' }
    : {};
}

export interface NodeFunctionProps extends Omit<NodejsFunctionProps, 'entry' | 'runtime'> {
  /** Repo-root-relative path to the handler module. */
  entry: string;
}

export function nodeFunction(
  scope: Construct,
  id: string,
  props: NodeFunctionProps,
): NodejsFunction {
  const { entry, ...rest } = props;
  return new NodejsFunction(scope, id, {
    runtime: LAMBDA_DEFAULTS.runtime,
    entry: path.join(REPO_ROOT, entry),
    handler: 'handler',
    memorySize: 512,
    timeout: cdk.Duration.seconds(30),
    bundling: {
      minify: false,
      sourceMap: true,
      target: 'node22',
      format: OutputFormat.CJS,
      // Bundle the AWS SDK rather than relying on whatever version the
      // LocalStack Lambda image ships with.
      externalModules: [],
    },
    ...rest,
  });
}
