/**
 * Cell placement — deciding which cell a new tenant lands in.
 *
 * Kept as a pure function of (tenant tier, cell inventory) so it can be
 * unit-tested and reasoned about without any AWS involvement. The rules:
 *
 *   premium  -> a silo cell, exclusively. This is the "bridge" half of the
 *               tiered isolation model: paying more buys you blast-radius and
 *               noisy-neighbour isolation that pooling cannot give you.
 *   standard -> the least-loaded pooled cell with room left.
 *
 * When nothing has capacity, placement fails loudly rather than overfilling a
 * cell. "Add another cell" is the intended answer to growth — that is the
 * whole point of the architecture, and silently exceeding capacity would erase
 * the property being bought.
 */
import type { CellRuntimeConfig, TenantTier } from './types.js';

export interface PlacementCandidate {
  cellId: string;
  tier: CellRuntimeConfig['tier'];
  capacity: number;
  tenantCount: number;
}

export class NoCapacityError extends Error {
  readonly statusCode = 507;
  constructor(tier: TenantTier) {
    super(`no cell with free capacity for a ${tier} tenant; deploy another cell`);
    this.name = 'NoCapacityError';
  }
}

export function placeTenant(
  tier: TenantTier,
  candidates: PlacementCandidate[],
): PlacementCandidate {
  const wanted = tier === 'premium' ? 'silo' : 'pooled';
  const eligible = candidates
    .filter((c) => c.tier === wanted && c.tenantCount < c.capacity)
    // Least loaded first; cell id as a tiebreak so placement is deterministic
    // and tests do not depend on map ordering.
    .sort((a, b) => a.tenantCount - b.tenantCount || a.cellId.localeCompare(b.cellId));

  const chosen = eligible[0];
  if (!chosen) throw new NoCapacityError(tier);
  return chosen;
}

/**
 * Default per-tier request budgets, applied at the router.
 *
 * These are deliberately small. LocalStack serves a request in roughly a
 * second under load, and it wedges above ~12 concurrent Lambda containers, so
 * a client on this machine tops out near 5 rps per tenant. A "realistic"
 * limit of a few hundred rps could never be reached locally, which would make
 * throttling unobservable and the noisy-neighbour scenario a no-op.
 *
 * Scale both tiers up when pointing at real AWS; the ratio between them, not
 * the absolute value, is what the prototype is demonstrating.
 */
export function defaultRateLimit(tier: TenantTier): { rps: number; burst: number } {
  return tier === 'premium' ? { rps: 50, burst: 100 } : { rps: 2, burst: 5 };
}
