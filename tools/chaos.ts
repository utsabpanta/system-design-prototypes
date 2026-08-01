/**
 * Fault injection CLI.
 *
 *   npm run chaos -- status
 *   npm run chaos -- set cell-a error
 *   npm run chaos -- set cell-b latency
 *   npm run chaos -- clear cell-a
 *   npm run chaos -- clear-all
 *
 * Writes /cells/<id>/fault in SSM. Cell code reads it with a 2s cache, so a
 * fault takes effect within a couple of seconds and needs no redeploy.
 */
import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { ssmClient } from '../packages/shared/aws.js';
import { listCells } from '../packages/shared/cell-directory.js';
import { faultParameterName } from '../packages/shared/faults.js';
import type { FaultMode } from '../packages/shared/types.js';

const MODES: FaultMode[] = ['none', 'latency', 'error', 'blackhole'];

const DESCRIPTIONS: Record<FaultMode, string> = {
  none: 'healthy',
  latency: 'adds ~1.5s to every request (drives p99, not errors)',
  error: 'every request and queued task fails',
  blackhole: 'requests hang until something upstream times out',
};

async function setFault(cellId: string, mode: FaultMode): Promise<void> {
  await ssmClient().send(
    new PutParameterCommand({
      Name: faultParameterName(cellId),
      Value: mode,
      Type: 'String',
      Overwrite: true,
    }),
  );
  console.log(`${cellId}: ${mode}  (${DESCRIPTIONS[mode]})`);
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

async function main(): Promise<void> {
  const [command, cellArg, modeArg] = process.argv.slice(2);
  const cells = await listCells(true);

  if (!command || command === 'status') {
    console.log('cell      tier    fault');
    for (const c of cells) {
      const fault = await readFault(c.cellId);
      const flag = fault === 'none' ? ' ' : '!';
      console.log(`${flag} ${c.cellId.padEnd(8)} ${c.tier.padEnd(7)} ${fault}`);
    }
    return;
  }

  if (command === 'clear-all') {
    for (const c of cells) await setFault(c.cellId, 'none');
    return;
  }

  if (!cellArg) throw new Error('usage: chaos <set|clear> <cellId> [mode]');
  if (!cells.some((c) => c.cellId === cellArg)) {
    throw new Error(`unknown cell ${cellArg}; known: ${cells.map((c) => c.cellId).join(', ')}`);
  }

  if (command === 'clear') return setFault(cellArg, 'none');

  if (command === 'set') {
    const mode = modeArg as FaultMode;
    if (!MODES.includes(mode)) {
      throw new Error(`mode must be one of: ${MODES.join(', ')}`);
    }
    return setFault(cellArg, mode);
  }

  throw new Error(`unknown command ${command}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
