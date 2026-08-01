/**
 * The cell inventory.
 *
 * This list is the only thing that decides how many cells exist. Adding an
 * entry and redeploying creates a new, fully independent cell — that is the
 * property being prototyped, so keep the file boring and declarative.
 */
import type { CellTier } from '../../packages/shared/types.js';

export interface CellDefinition {
  id: string;
  tier: CellTier;
  /** Maximum tenants the placement strategy will put here. */
  capacity: number;
  /**
   * Caps how much of the account's Lambda concurrency this cell can consume.
   * This is the bulkhead: a cell saturating under load cannot starve its
   * siblings of concurrency, which is half of blast-radius containment.
   */
  reservedConcurrency?: number;
}

/**
 * Reserved concurrency must sum to less than the account limit
 * (LAMBDA_LIMITS_CONCURRENT_EXECUTIONS in docker-compose.yml), otherwise the
 * reservations are unsatisfiable. 3 x 6 = 18 against a limit of 25 leaves
 * headroom for the router, admin, and worker functions.
 */
export const CELLS: CellDefinition[] = [
  { id: 'cell-a', tier: 'pooled', capacity: 5, reservedConcurrency: 6 },
  { id: 'cell-b', tier: 'pooled', capacity: 5, reservedConcurrency: 6 },
  { id: 'cell-c', tier: 'silo', capacity: 1, reservedConcurrency: 6 },
];

export function cellStackName(cellId: string): string {
  return `Cell-${cellId.replace(/^cell-/, '')}`;
}

export const CONTROL_PLANE_STACK = 'ControlPlane';

/** SSM key each cell publishes its runtime coordinates to. */
export function cellConfigParameter(cellId: string): string {
  return `/cells/${cellId}/config`;
}
