/**
 * API Gateway (REST v1) response helpers.
 *
 * Every response carries X-Cell-Id, so tests, the load generator, and the
 * dashboard can attribute any request to a cell without inference.
 */
import type { APIGatewayProxyResult } from 'aws-lambda';

export interface ResponseOptions {
  cellId?: string;
  tenantId?: string;
  headers?: Record<string, string>;
}

export function json(
  statusCode: number,
  body: unknown,
  opts: ResponseOptions = {},
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      ...(opts.cellId ? { 'x-cell-id': opts.cellId } : {}),
      ...(opts.tenantId ? { 'x-tenant-id': opts.tenantId } : {}),
      ...opts.headers,
    },
    body: JSON.stringify(body),
  };
}

export function error(
  statusCode: number,
  code: string,
  message: string,
  opts: ResponseOptions = {},
): APIGatewayProxyResult {
  return json(statusCode, { error: { code, message } }, opts);
}

/** Case-insensitive header lookup — API Gateway does not normalise casing. */
export function header(
  headers: Record<string, string | undefined> | null | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v ?? undefined;
  }
  return undefined;
}

export class BadRequestError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

export function parseBody<T>(body: string | null, isBase64 = false): T {
  if (!body) return {} as T;
  const raw = isBase64 ? Buffer.from(body, 'base64').toString('utf8') : body;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A client that forgets content-type: application/json arrives here with a
    // form-encoded body. That is the caller's mistake, not a server fault.
    throw new BadRequestError('body must be valid JSON (set content-type: application/json)');
  }
}
