/**
 * Prints the deployed endpoints.
 *
 * LocalStack assigns a new API Gateway id on every reset, so these URLs change
 * constantly. Rather than have anyone parse stack outputs by hand, the stacks
 * publish them to SSM and this prints them — optionally as shell exports:
 *
 *   pnpm run urls
 *   eval "$(pnpm run --silent urls --export)"   # sets $ROUTER and $ADMIN
 */
import { adminEndpoint, routerEndpoint } from '../packages/shared/endpoints.js';
import { listCells } from '../packages/shared/cell-directory.js';

async function main(): Promise<void> {
  const asExports = process.argv.includes('--export');

  const [router, admin, cells] = await Promise.all([
    routerEndpoint(),
    adminEndpoint(),
    listCells(true),
  ]);

  if (asExports) {
    console.log(`export ROUTER='${router}'`);
    console.log(`export ADMIN='${admin}'`);
    return;
  }

  console.log(`router     ${router}`);
  console.log(`admin      ${admin}`);
  console.log(`dashboard  http://localhost:4000   (pnpm run dash)`);
  console.log('\ncells (reachable directly — the router is not the only way in):');
  for (const c of cells) {
    console.log(`  ${c.cellId.padEnd(8)} ${c.tier.padEnd(7)} ${c.endpoint}`);
  }
  console.log('\ntip: eval "$(pnpm run --silent urls --export)" to get $ROUTER and $ADMIN');
}

main().catch((err) => {
  console.error(
    err instanceof Error ? err.message : err,
    '\n(is the ControlPlane stack deployed? try: pnpm run deploy)',
  );
  process.exit(1);
});
