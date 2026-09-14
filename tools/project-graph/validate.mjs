#!/usr/bin/env node
/**
 * Architecture boundary gate.
 *
 * Wraps dependency-cruiser so the CI gate does not fail merely because a
 * workspace directory does not exist yet — `apps/` is empty until EPIC 1, and
 * a fresh clone therefore has no `apps/` at all. Only genuine rule violations
 * should fail this job.
 *
 * Run: pnpm graph:validate
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const BIN = join(ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs');

const targets = ['apps', 'packages', 'tools'].filter((d) => existsSync(join(ROOT, d)));

if (targets.length === 0) {
  console.log('graph:validate: no source directories present yet — nothing to check.');
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [BIN, '--config', '.dependency-cruiser.cjs', ...targets],
  {
    cwd: ROOT,
    stdio: 'inherit',
  },
);

process.exit(result.status ?? 1);
