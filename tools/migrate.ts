/**
 * Tenant migration CLI.
 *
 *   npm run migrate -- --tenant acme --to cell-b
 *   npm run migrate -- --tenant acme --to cell-b --fail-after-copy   # rollback drill
 *
 * Follows the state machine to completion and prints where the tenant ends up.
 */
import { adminEndpoint, call } from '../packages/shared/endpoints.js';
import type { RoutingEntry } from '../packages/shared/types.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function currentCell(admin: string, tenantId: string): Promise<string | undefined> {
  const res = await call<{ routing: RoutingEntry | null }>(
    `${admin}/admin/tenants/${tenantId}`,
  );
  return res.body.routing?.cellId;
}

async function main(): Promise<void> {
  const tenantId = arg('tenant');
  const targetCellId = arg('to');
  const failAfterCopy = process.argv.includes('--fail-after-copy');

  if (!tenantId || !targetCellId) {
    throw new Error('usage: npm run migrate -- --tenant <id> --to <cellId> [--fail-after-copy]');
  }

  const admin = await adminEndpoint();
  const before = await currentCell(admin, tenantId);
  console.log(`tenant ${tenantId}: ${before} -> ${targetCellId}`);
  if (failAfterCopy) console.log('(rollback drill: copy will be failed deliberately)\n');

  const start = await call<{ executionArn: string }>(`${admin}/admin/migrations`, {
    method: 'POST',
    body: { tenantId, targetCellId, failAfterCopy },
  });
  if (start.status !== 202) {
    throw new Error(`could not start migration: ${JSON.stringify(start.body)}`);
  }

  const arn = start.body.executionArn;
  process.stdout.write('running');

  const deadline = Date.now() + 300_000;
  let status = 'RUNNING';
  let detail: Record<string, unknown> = {};
  while (status === 'RUNNING' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    process.stdout.write('.');
    const res = await call<{ status: string; error?: string; cause?: string }>(
      `${admin}/admin/migrations?executionArn=${encodeURIComponent(arn)}`,
    );
    status = res.body.status ?? 'UNKNOWN';
    detail = res.body as Record<string, unknown>;
  }
  console.log(`\nstatus: ${status}`);

  if (status !== 'SUCCEEDED') {
    console.log(`error: ${detail.error ?? '(none)'}  cause: ${detail.cause ?? '(none)'}`);
  }

  const after = await currentCell(admin, tenantId);
  console.log(`tenant ${tenantId} now served by: ${after}`);
  if (status === 'SUCCEEDED' && after !== targetCellId) {
    throw new Error('migration reported success but routing did not move');
  }
  if (status !== 'SUCCEEDED' && after !== before) {
    throw new Error(`rollback failed: tenant moved to ${after} despite a failed migration`);
  }
  if (status !== 'SUCCEEDED') {
    console.log('rollback verified: the tenant is still served by its original cell.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
