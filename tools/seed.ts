/**
 * Seeds the control plane: teach it which cells exist, then onboard tenants
 * and let the placement strategy spread them.
 *
 * Idempotent — re-running never double-places a tenant.
 */
import { adminEndpoint, call } from '../packages/shared/endpoints.js';
import type { CellRecord, RoutingEntry, Tenant, TenantTier } from '../packages/shared/types.js';

interface SeedTenant {
  tenantId: string;
  name: string;
  tier: TenantTier;
}

const TENANTS: SeedTenant[] = [
  { tenantId: 'acme', name: 'Acme Corp', tier: 'standard' },
  { tenantId: 'globex', name: 'Globex', tier: 'standard' },
  { tenantId: 'initech', name: 'Initech', tier: 'standard' },
  { tenantId: 'umbrella', name: 'Umbrella', tier: 'standard' },
  { tenantId: 'hooli', name: 'Hooli', tier: 'standard' },
  { tenantId: 'soylent', name: 'Soylent', tier: 'standard' },
  { tenantId: 'stark', name: 'Stark Industries', tier: 'standard' },
  { tenantId: 'wayne', name: 'Wayne Enterprises', tier: 'standard' },
  { tenantId: 'bigco', name: 'BigCo (dedicated)', tier: 'premium' },
];

async function main(): Promise<void> {
  const admin = await adminEndpoint();
  console.log(`control plane: ${admin}\n`);

  const sync = await call<{ cells: CellRecord[] }>(`${admin}/admin/cells/sync`, {
    method: 'POST',
  });
  if (sync.status !== 200) {
    throw new Error(`cell sync failed (${sync.status}): ${JSON.stringify(sync.body)}`);
  }
  console.log('cells discovered from SSM:');
  for (const c of sync.body.cells) {
    console.log(`  ${c.cellId.padEnd(8)} ${c.tier.padEnd(7)} capacity=${c.capacity}`);
  }
  console.log();

  const placements: { tenantId: string; tier: string; cellId: string; created: boolean }[] = [];
  for (const t of TENANTS) {
    const res = await call<{ tenant: Tenant; routing: RoutingEntry; created: boolean }>(
      `${admin}/admin/tenants`,
      { method: 'POST', body: t },
    );
    if (res.status >= 400) {
      console.error(`  ${t.tenantId}: FAILED ${res.status} ${JSON.stringify(res.body)}`);
      continue;
    }
    placements.push({
      tenantId: t.tenantId,
      tier: t.tier,
      cellId: res.body.routing.cellId,
      created: res.body.created,
    });
  }

  console.log('tenant placement:');
  for (const p of placements) {
    console.log(
      `  ${p.tenantId.padEnd(10)} ${p.tier.padEnd(9)} -> ${p.cellId}${p.created ? '' : '  (already placed)'}`,
    );
  }

  const cells = await call<{ cells: CellRecord[] }>(`${admin}/admin/cells`);
  console.log('\ncell occupancy:');
  for (const c of cells.body.cells) {
    console.log(`  ${c.cellId.padEnd(8)} ${c.tenantCount}/${c.capacity} tenants (${c.tier})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
