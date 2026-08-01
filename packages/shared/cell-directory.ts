/**
 * Runtime cell discovery.
 *
 * Cells publish their coordinates to SSM at /cells/<id>/config; the control
 * plane reads them back. This is the seam that keeps cell stacks independent:
 * no CloudFormation export ties a cell to the router, so a cell can be
 * deployed, redeployed, or torn down without touching anything else.
 */
import { GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { ssmClient } from './aws.js';
import type { CellRuntimeConfig } from './types.js';

export const CELL_CONFIG_PREFIX = '/cells/';
const CACHE_TTL_MS = 30_000;

let cache: { configs: Map<string, CellRuntimeConfig>; expiresAt: number } | undefined;

export async function listCells(force = false): Promise<CellRuntimeConfig[]> {
  const map = await cellMap(force);
  return [...map.values()].sort((a, b) => a.cellId.localeCompare(b.cellId));
}

export async function getCell(
  cellId: string,
  force = false,
): Promise<CellRuntimeConfig | undefined> {
  return (await cellMap(force)).get(cellId);
}

async function cellMap(force: boolean): Promise<Map<string, CellRuntimeConfig>> {
  if (!force && cache && cache.expiresAt > Date.now()) return cache.configs;

  const configs = new Map<string, CellRuntimeConfig>();
  let nextToken: string | undefined;
  do {
    const res = await ssmClient().send(
      new GetParametersByPathCommand({
        Path: CELL_CONFIG_PREFIX,
        Recursive: true,
        NextToken: nextToken,
      }),
    );
    for (const p of res.Parameters ?? []) {
      if (!p.Name?.endsWith('/config') || !p.Value) continue;
      try {
        const cfg = JSON.parse(p.Value) as CellRuntimeConfig;
        configs.set(cfg.cellId, cfg);
      } catch {
        console.warn(JSON.stringify({ msg: 'unparseable cell config', parameter: p.Name }));
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);

  cache = { configs, expiresAt: Date.now() + CACHE_TTL_MS };
  return configs;
}

/** Test/tool helper — drops the cache so the next read hits SSM. */
export function invalidateCellCache(): void {
  cache = undefined;
}
