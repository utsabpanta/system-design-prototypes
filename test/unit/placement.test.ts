import { describe, expect, it } from 'vitest';
import {
  defaultRateLimit,
  NoCapacityError,
  placeTenant,
  type PlacementCandidate,
} from '../../packages/shared/placement.js';
import { buildSessionPolicy } from '../../packages/shared/tenant-credentials.js';
import { TenantAuthError, TenantContext } from '../../packages/shared/tenant-context.js';

const pooled = (id: string, tenantCount: number, capacity = 5): PlacementCandidate => ({
  cellId: id,
  tier: 'pooled',
  capacity,
  tenantCount,
});
const silo = (id: string, tenantCount: number, capacity = 1): PlacementCandidate => ({
  cellId: id,
  tier: 'silo',
  capacity,
  tenantCount,
});

describe('placement', () => {
  it('sends standard tenants to the least loaded pooled cell', () => {
    const chosen = placeTenant('standard', [pooled('cell-a', 3), pooled('cell-b', 1)]);
    expect(chosen.cellId).toBe('cell-b');
  });

  it('breaks ties deterministically by cell id', () => {
    const chosen = placeTenant('standard', [pooled('cell-b', 2), pooled('cell-a', 2)]);
    expect(chosen.cellId).toBe('cell-a');
  });

  it('never puts a premium tenant in a pooled cell', () => {
    const chosen = placeTenant('premium', [pooled('cell-a', 0), silo('cell-c', 0)]);
    expect(chosen.cellId).toBe('cell-c');
  });

  it('never puts a standard tenant in a silo cell', () => {
    const chosen = placeTenant('standard', [silo('cell-c', 0), pooled('cell-a', 4)]);
    expect(chosen.cellId).toBe('cell-a');
  });

  it('refuses to overfill rather than exceeding capacity', () => {
    expect(() => placeTenant('standard', [pooled('cell-a', 5), pooled('cell-b', 5)])).toThrow(
      NoCapacityError,
    );
  });

  it('reports no capacity when a premium tenant has no free silo', () => {
    expect(() => placeTenant('premium', [silo('cell-c', 1), pooled('cell-a', 0)])).toThrow(
      /deploy another cell/,
    );
  });

  it('gives premium tenants a larger request budget', () => {
    expect(defaultRateLimit('premium').rps).toBeGreaterThan(defaultRateLimit('standard').rps);
  });
});

describe('tenant context', () => {
  it('rejects a request with no tenant header', () => {
    expect(() => TenantContext.fromHeaders({})).toThrow(TenantAuthError);
  });

  it('rejects a malformed tenant id', () => {
    expect(() => TenantContext.fromHeaders({ 'x-tenant-id': '../admin' })).toThrow(TenantAuthError);
    expect(() => TenantContext.fromHeaders({ 'x-tenant-id': 'A' })).toThrow(TenantAuthError);
  });

  it('is case-insensitive about header names', () => {
    const ctx = TenantContext.fromHeaders({ 'X-Tenant-Id': 'acme' });
    expect(ctx.tenantId).toBe('acme');
  });

  it('namespaces every tenant into its own partition', () => {
    expect(TenantContext.forSystem('acme').partitionKey).toBe('TENANT#acme');
    expect(TenantContext.forSystem('acme2').partitionKey).not.toBe(
      TenantContext.forSystem('acme').partitionKey,
    );
  });
});

describe('scoped credential policy', () => {
  const tableArn = 'arn:aws:dynamodb:us-east-1:000000000000:table/cell-a-tasks';
  interface PolicyStatement {
    Sid: string;
    Effect: string;
    Action: string[];
    Resource: string[];
    Condition?: Record<string, Record<string, string[]>>;
  }
  const policy = JSON.parse(buildSessionPolicy({ tableArn, leadingKey: 'TENANT#acme' })) as {
    Statement: PolicyStatement[];
  };

  it('constrains item access to the tenant partition', () => {
    const allow = policy.Statement.find((s) => s.Sid === 'TenantScopedItemAccess')!;
    expect(allow.Effect).toBe('Allow');
    expect(allow.Condition?.['ForAllValues:StringEquals']['dynamodb:LeadingKeys']).toEqual([
      'TENANT#acme',
    ]);
  });

  it('denies table-wide scans, which LeadingKeys cannot constrain', () => {
    const deny = policy.Statement.find((s) => s.Sid === 'DenyTableWideScan')!;
    expect(deny.Effect).toBe('Deny');
    expect(deny.Action).toContain('dynamodb:Scan');
  });

  it('grants nothing outside the cell table', () => {
    for (const statement of policy.Statement) {
      for (const resource of statement.Resource) {
        expect(resource.startsWith(tableArn)).toBe(true);
      }
    }
  });
});
