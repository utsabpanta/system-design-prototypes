/**
 * Endpoint lookup for tools and tests.
 *
 * The control plane publishes its URLs to SSM at deploy time, so nothing
 * outside CDK has to parse CloudFormation outputs or hardcode a hostname.
 */
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { ssmClient } from './aws.js';

async function param(name: string): Promise<string> {
  const res = await ssmClient().send(new GetParameterCommand({ Name: name }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} is empty — is ControlPlane deployed?`);
  return value;
}

export function routerEndpoint(): Promise<string> {
  return param('/control-plane/router-endpoint');
}

export function adminEndpoint(): Promise<string> {
  return param('/control-plane/admin-endpoint');
}

export interface ApiCallOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/** Thin fetch wrapper that never throws on non-2xx — callers assert instead. */
export async function call<T = unknown>(
  url: string,
  opts: ApiCallOptions = {},
): Promise<ApiResponse<T>> {
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* leave as text */
  }
  return { status: res.status, body: body as T, headers: res.headers };
}
