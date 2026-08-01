/**
 * Multi-tenant load generator.
 *
 * The point is not raw throughput — LocalStack could never deliver it. The
 * point is *attribution*: every result is tagged with the tenant that sent it
 * and the cell that served it, so the report shows where load landed and where
 * failures were contained. A single aggregate number would hide exactly the
 * behaviour worth looking at.
 *
 *   pnpm run load                                          # baseline
 *   pnpm run load --scenario noisy-neighbor
 *   pnpm run load --scenario cell-failure                  # injects its own fault
 *   pnpm run load --scenario baseline --duration 30
 *   pnpm run load --keep-faults                            # honour `chaos set`
 */
import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { ssmClient } from '../packages/shared/aws.js';
import { LOCAL_SAFE_CONCURRENCY } from '../packages/shared/concurrency.js';
import { listCells } from '../packages/shared/cell-directory.js';
import { routerEndpoint } from '../packages/shared/endpoints.js';
import { faultParameterName } from '../packages/shared/faults.js';
import type { FaultMode } from '../packages/shared/types.js';

/**
 * The generator may run hotter than the default guardrail: it spreads work
 * across cells, and observed behaviour is that ~12 in flight is absorbed while
 * ~25 wedges the emulator. Override with LOADGEN_CONCURRENCY if your machine
 * disagrees.
 */
const LOADGEN_CONCURRENCY = Number(
  process.env.LOADGEN_CONCURRENCY ?? LOCAL_SAFE_CONCURRENCY + 4,
);

interface TenantLoad {
  tenantId: string;
  rps: number;
}

interface Scenario {
  name: string;
  description: string;
  tenants: TenantLoad[];
  /** Fires partway through the run. */
  midRun?: {
    atFraction: number;
    describe: string;
    apply: () => Promise<void>;
  };
}

interface Sample {
  tenantId: string;
  cellId: string;
  status: number;
  latencyMs: number;
  atMs: number;
}

/** Well-behaved traffic: 1 rps against a standard budget of 2 rps. */
const STANDARD: TenantLoad[] = [
  { tenantId: 'acme', rps: 1 },
  { tenantId: 'globex', rps: 1 },
  { tenantId: 'initech', rps: 1 },
  { tenantId: 'umbrella', rps: 1 },
];

async function setFault(cellId: string, mode: FaultMode): Promise<void> {
  await ssmClient().send(
    new PutParameterCommand({
      Name: faultParameterName(cellId),
      Value: mode,
      Type: 'String',
      Overwrite: true,
    }),
  );
}

async function readFault(cellId: string): Promise<FaultMode> {
  try {
    const res = await ssmClient().send(
      new GetParameterCommand({ Name: faultParameterName(cellId) }),
    );
    return (res.Parameter?.Value as FaultMode) ?? 'none';
  } catch {
    return 'none';
  }
}

function buildScenarios(victimCell: string): Record<string, Scenario> {
  return {
    baseline: {
      name: 'baseline',
      description: 'every tenant inside its budget; nothing should fail',
      tenants: [...STANDARD, { tenantId: 'bigco', rps: 3 }],
    },
    'noisy-neighbor': {
      name: 'noisy-neighbor',
      description: 'one tenant floods at 10x budget; co-tenants should not notice',
      tenants: [
        { tenantId: 'acme', rps: 50 }, // far past the standard tier's 2 rps
        ...STANDARD.filter((t) => t.tenantId !== 'acme'),
        { tenantId: 'bigco', rps: 3 },
      ],
    },
    'cell-failure': {
      name: 'cell-failure',
      description: `${victimCell} fails mid-run; other cells should be untouched`,
      tenants: [...STANDARD, { tenantId: 'bigco', rps: 3 }],
      midRun: {
        atFraction: 0.4,
        describe: `injecting 'error' into ${victimCell}`,
        apply: () => setFault(victimCell, 'error'),
      },
    },
  };
}

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main(): Promise<void> {
  const durationSec = Number(arg('duration', '20'));
  const scenarioName = arg('scenario', 'baseline');
  const keepFaults = process.argv.includes('--keep-faults');

  const cells = await listCells(true);
  const victimCell = cells.find((c) => c.tier === 'pooled')?.cellId ?? 'cell-a';
  const scenarios = buildScenarios(victimCell);
  const scenario = scenarios[scenarioName];
  if (!scenario) {
    throw new Error(`unknown scenario '${scenarioName}'; try: ${Object.keys(scenarios).join(', ')}`);
  }

  const router = await routerEndpoint();
  console.log(`scenario   ${scenario.name} — ${scenario.description}`);
  console.log(`router     ${router}`);
  console.log(`duration   ${durationSec}s`);
  console.log(
    `offered    ${scenario.tenants.map((t) => `${t.tenantId}@${t.rps}rps`).join(', ')}\n`,
  );

  // Leftover faults from a previous run would silently poison the results, so
  // the default is to clear them. But an operator who just ran `chaos set` and
  // then a load test means for that fault to be in effect — silently undoing it
  // made the documented blast-radius exercise report a clean run. Clearing is
  // therefore announced, and --keep-faults opts out.
  const preExisting = await Promise.all(
    cells.map(async (c) => ({ cellId: c.cellId, fault: await readFault(c.cellId) })),
  );
  const faulted = preExisting.filter((c) => c.fault !== 'none');

  if (keepFaults) {
    console.log(
      faulted.length
        ? `keeping pre-existing faults: ${faulted.map((c) => `${c.cellId}=${c.fault}`).join(', ')}\n`
        : 'no pre-existing faults to keep\n',
    );
  } else {
    if (faulted.length) {
      console.log(
        `clearing pre-existing faults (${faulted
          .map((c) => `${c.cellId}=${c.fault}`)
          .join(', ')}) — pass --keep-faults to preserve them\n`,
      );
    }
    for (const c of cells) await setFault(c.cellId, 'none');
  }
  await new Promise((r) => setTimeout(r, 2500));

  const samples: Sample[] = [];
  const startedAt = Date.now();
  const endAt = startedAt + durationSec * 1000;
  let inFlight = 0;
  let shed = 0;

  /**
   * Each tenant gets its own slice of the generator's concurrency, because a
   * single global pool makes the *client* the bottleneck: an abuser at 50 rps
   * fills every slot and the well-behaved tenants stop being measured at all.
   * That would report the load tool's queueing as if it were the system's
   * behaviour — the exact confusion this scenario exists to avoid. Real
   * tenants are separate clients with separate connection pools, so modelling
   * them as separate budgets is also the more faithful shape.
   *
   * The split is a guaranteed floor plus a share weighted by offered rate: a
   * quiet tenant is always measured, and a tenant genuinely trying to send
   * more gets the slots to actually do it (otherwise it could never exceed its
   * server-side budget and the scenario would demonstrate nothing).
   */
  const FLOOR = 2;
  const totalRps = scenario.tenants.reduce((sum, t) => sum + t.rps, 0);
  const spare = Math.max(0, LOADGEN_CONCURRENCY - FLOOR * scenario.tenants.length);
  const caps = new Map(
    scenario.tenants.map((t) => [t.tenantId, FLOOR + Math.round((t.rps / totalRps) * spare)]),
  );
  const tenantInFlight = new Map<string, number>();

  async function fire(tenantId: string): Promise<void> {
    // Never let the generator exceed what the emulator can take; requests we
    // decline to send are reported rather than hidden.
    const mine = tenantInFlight.get(tenantId) ?? 0;
    if (mine >= (caps.get(tenantId) ?? FLOOR)) {
      shed++;
      return;
    }
    tenantInFlight.set(tenantId, mine + 1);
    inFlight++;
    const at = Date.now();
    try {
      const res = await fetch(`${router}/v1/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({ kind: 'load', durationMs: 10 }),
        signal: AbortSignal.timeout(15_000),
      });
      samples.push({
        tenantId,
        cellId: res.headers.get('x-cell-id') ?? 'unrouted',
        status: res.status,
        latencyMs: Date.now() - at,
        atMs: at - startedAt,
      });
    } catch {
      samples.push({
        tenantId,
        cellId: 'unreachable',
        status: 0,
        latencyMs: Date.now() - at,
        atMs: at - startedAt,
      });
    } finally {
      inFlight--;
      tenantInFlight.set(tenantId, (tenantInFlight.get(tenantId) ?? 1) - 1);
    }
  }

  const timers = scenario.tenants.map((t) =>
    setInterval(() => void fire(t.tenantId), Math.max(10, Math.round(1000 / t.rps))),
  );

  let midRunFired = false;
  const progress = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    if (
      scenario.midRun &&
      !midRunFired &&
      elapsed >= durationSec * scenario.midRun.atFraction
    ) {
      midRunFired = true;
      console.log(`  t=${elapsed.toFixed(0)}s  ${scenario.midRun.describe}`);
      void scenario.midRun.apply();
    }
    process.stdout.write(
      `\r  t=${elapsed.toFixed(0)}s  sent=${samples.length}  inflight=${inFlight}   `,
    );
  }, 1000);

  await new Promise((r) => setTimeout(r, endAt - Date.now()));
  for (const t of timers) clearInterval(t);
  clearInterval(progress);

  // Let in-flight requests land before reporting.
  while (inFlight > 0) await new Promise((r) => setTimeout(r, 200));
  process.stdout.write('\r'.padEnd(60) + '\r');

  report(samples, shed, durationSec, caps);

  // --keep-faults leaves the cells exactly as the operator set them, so a
  // chaos state can outlive the run and be inspected on the dashboard.
  if (keepFaults) {
    console.log('\nfaults left in place (--keep-faults). Clear with: pnpm run chaos clear-all');
  } else {
    for (const c of cells) await setFault(c.cellId, 'none');
    console.log('\nfaults cleared.');
  }
}

function report(
  samples: Sample[],
  shed: number,
  durationSec: number,
  caps: Map<string, number>,
): void {
  const ok = (s: Sample) => s.status >= 200 && s.status < 300;
  const throttled = (s: Sample) => s.status === 429;
  const failed = (s: Sample) => s.status === 0 || s.status >= 500;

  console.log(`\n${'BY TENANT'.padEnd(12)} ${'sent'.padStart(6)} ${'ok'.padStart(6)} ${'429'.padStart(6)} ${'fail'.padStart(6)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)}`);
  const tenants = [...new Set(samples.map((s) => s.tenantId))].sort();
  for (const t of tenants) {
    const rows = samples.filter((s) => s.tenantId === t);
    const lat = rows.filter(ok).map((s) => s.latencyMs);
    console.log(
      `${t.padEnd(12)} ${String(rows.length).padStart(6)} ${String(rows.filter(ok).length).padStart(6)} ` +
        `${String(rows.filter(throttled).length).padStart(6)} ${String(rows.filter(failed).length).padStart(6)} ` +
        `${(percentile(lat, 50) + 'ms').padStart(7)} ${(percentile(lat, 95) + 'ms').padStart(7)} ${(percentile(lat, 99) + 'ms').padStart(7)}`,
    );
  }

  console.log(`\n${'BY CELL'.padEnd(12)} ${'sent'.padStart(6)} ${'ok'.padStart(6)} ${'429'.padStart(6)} ${'fail'.padStart(6)} ${'p95'.padStart(7)}  tenants`);
  const cells = [...new Set(samples.map((s) => s.cellId))].sort();
  for (const c of cells) {
    const rows = samples.filter((s) => s.cellId === c);
    const lat = rows.filter(ok).map((s) => s.latencyMs);
    const names = [...new Set(rows.map((s) => s.tenantId))].sort().join(',');
    console.log(
      `${c.padEnd(12)} ${String(rows.length).padStart(6)} ${String(rows.filter(ok).length).padStart(6)} ` +
        `${String(rows.filter(throttled).length).padStart(6)} ${String(rows.filter(failed).length).padStart(6)} ` +
        `${(percentile(lat, 95) + 'ms').padStart(7)}  ${names}`,
    );
  }

  const failures = samples.filter(failed);
  console.log(
    `\ntotal ${samples.length} requests in ${durationSec}s ` +
      `(${(samples.length / durationSec).toFixed(1)} rps achieved), ` +
      `${samples.filter(ok).length} ok, ${samples.filter(throttled).length} throttled, ${failures.length} failed`,
  );
  if (shed > 0) {
    // Never let a client-side cap masquerade as the system keeping up.
    console.log(
      `note: ${shed} requests were not sent — a tenant hit the generator's own ` +
        `per-tenant concurrency cap (${[...caps].map(([t, c]) => `${t}=${c}`).join(' ')}). ` +
        `Offered load exceeded what LocalStack can absorb; this is a client-side limit, not a system result.`,
    );
  }

  if (failures.length) {
    const byCell = new Map<string, number>();
    for (const f of failures) byCell.set(f.cellId, (byCell.get(f.cellId) ?? 0) + 1);
    console.log(
      `failures by cell: ${[...byCell].map(([c, n]) => `${c}=${n}`).join(', ')}` +
        `  <- containment is visible here: a failing cell should be the only one listed`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
