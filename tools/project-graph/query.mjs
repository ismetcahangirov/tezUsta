#!/usr/bin/env node
/**
 * Query the TezUsta project graph.
 *
 * Answers, for a given file, the questions CLAUDE.md § "Never destroy existing
 * work" requires before any edit:
 *   - what does this import?
 *   - what imports this? (blast radius)
 *   - which tests cover it?
 *   - which modules are affected?
 *
 * Usage:
 *   node tools/project-graph/query.mjs apps/api/src/modules/orders/orders.service.ts
 *   node tools/project-graph/query.mjs orders.service          # substring match
 *   node tools/project-graph/query.mjs --untested apps/api     # files lacking tests
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, 'output', 'index.json');

if (!existsSync(INDEX)) {
  console.error('No graph found. Run `pnpm graph` first.');
  process.exit(1);
}

const index = JSON.parse(readFileSync(INDEX, 'utf8'));
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: query.mjs <file-or-substring> | --untested [prefix]');
  process.exit(1);
}

if (args[0] === '--untested') {
  const prefix = args[1] ?? '';
  const rows = Object.entries(index.files)
    .filter(([p, i]) => !i.isTest && i.coveredByTests.length === 0 && p.startsWith(prefix))
    .map(([p]) => p)
    .sort();
  console.log(`Files with no direct test (${rows.length}):`);
  for (const r of rows) console.log('  ' + r);
  process.exit(0);
}

const needle = args[0].replace(/\\/g, '/');
const matches = Object.keys(index.files).filter((p) => p === needle || p.includes(needle));

if (matches.length === 0) {
  console.error(`No file in the graph matches "${needle}".`);
  console.error('Graph generated at:', index.generatedAt);
  process.exit(1);
}

if (matches.length > 1 && !index.files[needle]) {
  console.log(`${matches.length} matches for "${needle}":`);
  for (const m of matches) console.log('  ' + m);
  console.log('\nRe-run with a full path for the impact report.');
  process.exit(0);
}

const target = index.files[needle] ? needle : matches[0];
const info = index.files[target];

const list = (label, arr) => {
  console.log(`\n${label} (${arr.length}):`);
  if (arr.length === 0) console.log('  —');
  else for (const a of [...arr].sort()) console.log('  ' + a);
};

console.log(`\n=== ${target} ===`);
console.log(`workspace: ${info.workspace}`);
console.log(`module:    ${info.module}`);
console.log(`is test:   ${info.isTest}`);
if (info.orphan) console.log('WARNING: orphan module (nothing imports it).');

list('Depends on', info.dependsOn);
list('Depended on by (blast radius)', info.dependedOnBy);
list('Covered by tests', info.coveredByTests);

const affectedModules = [
  ...new Set(info.dependedOnBy.map((f) => index.files[f]?.module).filter(Boolean)),
];
list('Affected modules', affectedModules);

if (!info.isTest && info.coveredByTests.length === 0) {
  console.log('\nNOTE: no test imports this file. Definition of Done requires adding one.');
}
