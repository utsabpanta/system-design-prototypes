/**
 * The isolation chokepoint.
 *
 * Nothing in a cell touches tenant data without a TenantContext, and a context
 * cannot be constructed without a tenant id. Key construction lives here too,
 * so no handler is ever in a position to hand-build a partition key for a
 * tenant other than the caller's.
 */
import type { TenantTier } from './types.js';

export class TenantAuthError extends Error {
  readonly statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = 'TenantAuthError';
  }
}

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/;

export class TenantContext {
  private constructor(
    readonly tenantId: string,
    readonly tier: TenantTier,
  ) {}

  /**
   * Trusted construction. The router authenticates the caller and stamps
   * x-tenant-id / x-tenant-tier; a cell only ever sees an already-resolved
   * tenant. On real AWS the router would be a Lambda authorizer and these
   * would arrive as request-context authorizer claims rather than headers.
   */
  static fromHeaders(headers: Record<string, string | undefined>): TenantContext {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v !== undefined) lower[k.toLowerCase()] = v;
    }

    const tenantId = lower['x-tenant-id'];
    if (!tenantId) throw new TenantAuthError('missing x-tenant-id');
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new TenantAuthError(`malformed tenant id: ${tenantId}`);
    }

    const tier = lower['x-tenant-tier'] === 'premium' ? 'premium' : 'standard';
    return new TenantContext(tenantId, tier);
  }

  /** Explicit construction for control-plane jobs (migration, seeding). */
  static forSystem(tenantId: string, tier: TenantTier = 'standard'): TenantContext {
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new TenantAuthError(`malformed tenant id: ${tenantId}`);
    }
    return new TenantContext(tenantId, tier);
  }

  /** Every item belonging to this tenant shares this partition key. */
  get partitionKey(): string {
    return `TENANT#${this.tenantId}`;
  }

  /** The IAM condition value that scopes credentials to this partition. */
  get leadingKey(): string {
    return this.partitionKey;
  }
}
