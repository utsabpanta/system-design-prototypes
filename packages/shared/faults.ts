/**
 * Chaos knob, read by cell code at request time.
 *
 * The fault mode lives in SSM Parameter Store at /cells/<cellId>/fault so
 * tools/chaos.ts can degrade exactly one cell with no redeploy. A short TTL
 * cache keeps it off the hot path; it also means a fault takes up to
 * FAULT_CACHE_TTL_MS to take effect, which is realistic for config propagation.
 */
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { ssmClient } from './aws.js';
import type { FaultMode } from './types.js';

export const FAULT_CACHE_TTL_MS = 2000;

export function faultParameterName(cellId: string): string {
  return `/cells/${cellId}/fault`;
}

let cached: { value: FaultMode; expiresAt: number } | undefined;

export async function currentFault(cellId: string): Promise<FaultMode> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  let value: FaultMode = 'none';
  try {
    const res = await ssmClient().send(
      new GetParameterCommand({ Name: faultParameterName(cellId) }),
    );
    const raw = res.Parameter?.Value as FaultMode | undefined;
    if (raw === 'latency' || raw === 'error' || raw === 'blackhole') value = raw;
  } catch {
    // Parameter missing or SSM unreachable: fail open. A broken chaos control
    // plane must not itself take the cell down.
    value = 'none';
  }

  cached = { value, expiresAt: now + FAULT_CACHE_TTL_MS };
  return value;
}

export class InjectedFaultError extends Error {
  readonly statusCode = 503;
  constructor(readonly mode: FaultMode) {
    super(`injected fault: ${mode}`);
    this.name = 'InjectedFaultError';
  }
}

/**
 * Apply the cell's current fault. Returns normally when healthy.
 * - latency:   adds LATENCY_MS before continuing (drives p99 up, not errors)
 * - error:     throws immediately (cell returns 5xx)
 * - blackhole: hangs past the Lambda timeout (simulates a wedged dependency)
 */
export async function applyFault(cellId: string, latencyMs = 1500): Promise<void> {
  const mode = await currentFault(cellId);
  switch (mode) {
    case 'none':
      return;
    case 'latency':
      await new Promise((r) => setTimeout(r, latencyMs));
      return;
    case 'error':
      throw new InjectedFaultError('error');
    case 'blackhole':
      await new Promise((r) => setTimeout(r, 15 * 60 * 1000));
      return;
  }
}
