/**
 * Tenant CLI — onboard and inspect without hand-assembling curl commands
 * against an endpoint whose hostname changes on every LocalStack reset.
 *
 *   npm run tenant -- list
 *   npm run tenant -- add newco --tier premium
 *   npm run tenant -- show acme
 */
import { adminEndpoint, call } from '../packages/shared/endpoints.js';
import type { CellRecord, RoutingEntry, Tenant } from '../packages/shared/types.js';

function flag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const admin = await adminEndpoint();
  const [command, target] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

  if (!command || command === 'list') {
    const [tenants, routes, cells] = await Promise.all([
      call<{ tenants: Tenant[] }>(`${admin}/admin/tenants`),
      call<{ routes: RoutingEntry[] }>(`${admin}/admin/routing`),
      call<{ cells: CellRecord[] }>(`${admin}/admin/cells`),
    ]);
    const cellOf = new Map(routes.body.routes.map((r) => [r.tenantId, r]));

    console.log('tenant       tier       cell      status     rate');
    for (const t of tenants.body.tenants.sort((a, b) => a.tenantId.localeCompare(b.tenantId))) {
      const r = cellOf.get(t.tenantId);
      console.log(
        `${t.tenantId.padEnd(12)} ${t.tier.padEnd(10)} ${(r?.cellId ?? '-').padEnd(9)} ` +
          `${(r?.status ?? '-').padEnd(10)} ${t.rateLimit.rps}rps/${t.rateLimit.burst}burst`,
      );
    }

    console.log('\ncell     tier    occupancy');
    for (const c of cells.body.cells) {
      const full = c.tenantCount >= c.capacity ? '  FULL' : '';
      console.log(`${c.cellId.padEnd(8)} ${c.tier.padEnd(7)} ${c.tenantCount}/${c.capacity}${full}`);
    }
    return;
  }

  if (command === 'add') {
    if (!target) throw new Error('usage: npm run tenant -- add <tenantId> [--tier premium]');
    const res = await call<{ routing: RoutingEntry; created: boolean }>(
      `${admin}/admin/tenants`,
      { method: 'POST', body: { tenantId: target, tier: flag('tier') ?? 'standard' } },
    );
    if (res.status >= 400) {
      // 507 here is the architecture working: no cell has room, so the answer
      // is to deploy another one rather than overfill an existing cell.
      console.error(`${res.status}: ${JSON.stringify(res.body)}`);
      process.exit(1);
    }
    console.log(
      `${target} -> ${res.body.routing.cellId}${res.body.created ? '' : ' (already placed)'}`,
    );
    return;
  }

  if (command === 'show') {
    if (!target) throw new Error('usage: npm run tenant -- show <tenantId>');
    const res = await call(`${admin}/admin/tenants/${target}`);
    console.log(JSON.stringify(res.body, null, 2));
    return;
  }

  throw new Error(`unknown command '${command}'; try: list, add, show`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
