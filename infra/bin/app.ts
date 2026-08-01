#!/usr/bin/env tsx
/**
 * CDK app.
 *
 * One control-plane stack plus one stack per cell. Cells are produced by a
 * loop over CELLS — they are identical by construction, which is what lets you
 * argue that a change tested in one cell behaves the same in the rest.
 */
import * as cdk from 'aws-cdk-lib';
import { CELLS, CONTROL_PLANE_STACK, cellStackName } from '../lib/cells.config.js';
import { CellStack } from '../lib/cell-stack.js';
import { ControlPlaneStack } from '../lib/control-plane-stack.js';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? '000000000000',
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

for (const cell of CELLS) {
  new CellStack(app, cellStackName(cell.id), { cell, env });
}

new ControlPlaneStack(app, CONTROL_PLANE_STACK, { cells: CELLS, env });
