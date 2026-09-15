#!/usr/bin/env node
/**
 * TezUsta project graph generator.
 *
 * Purpose (CLAUDE.md § Project graph): let an agent answer "what breaks if I
 * change this file?" without reading the whole repository.
 *
 * Emits into tools/project-graph/output/:
 *   graph.json  — raw dependency-cruiser output (full fidelity)
 *   index.json  — condensed forward/reverse index, module + test mapping
 *   GRAPH.md    — human- and agent-readable summary
 *
 * Run: pnpm graph
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, 'output');

const DEPCRUISE_BIN = join(
  ROOT,
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruiser.mjs',
);

const SCAN_TARGETS = ['apps', 'packages', 'tools'].filter((d) => existsSync(join(ROOT, d)));

if (SCAN_TARGETS.length === 0) {
  console.error('project-graph: nothing to scan (no apps/, packages/ or tools/).');
  process.exit(1);
}

function isTest(p) {
  return /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|test|e2e)\//.test(p);
}

/** Workspace a file belongs to, e.g. apps/api or packages/types. */
function workspaceOf(p) {
  const m = /^((?:apps|packages|tools)\/[^/]+)\//.exec(p);
  return m ? m[1] : '(root)';
}

/** Backend module / mobile route group, e.g. apps/api/src/modules/orders. */
function moduleOf(p) {
  const m =
    /^(apps\/api\/src\/modules\/[^/]+)\//.exec(p) || /^(apps\/mobile\/app\/[^/]+)\//.exec(p);
  return m ? m[1] : workspaceOf(p);
}

console.log(`project-graph: scanning ${SCAN_TARGETS.join(', ')} ...`);

let raw;
try {
  raw = execFileSync(
    process.execPath,
    [
      DEPCRUISE_BIN,
      '--config',
      '.dependency-cruiser.cjs',
      '--output-type',
      'json',
      ...SCAN_TARGETS,
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
} catch (error) {
  // depcruise exits non-zero when a *rule* is violated, but still prints JSON.
  if (!error.stdout) {
    console.error('project-graph: dependency-cruiser failed to run.\n', error.message);
    process.exit(1);
  }
  raw = error.stdout;
}

const cruise = JSON.parse(raw);
const modules = cruise.modules ?? [];

mkdirSync(OUT, { recursive: true });

const isLocal = (p) => !p.includes('node_modules');

const local = modules
  .filter((m) => !m.coreModule && isLocal(m.source))
  .sort((a, b) => a.source.localeCompare(b.source));

// --- graph.json ------------------------------------------------------------
// The committed graph must be a pure function of the source tree, because CI
// regenerates it and fails on a non-empty diff. Raw cruise output is not:
//
//   * `summary.environment` carries the OS string and the Node version;
//   * `summary.optionsUsed.baseDir` is an absolute path;
//   * the node_modules leaves differ by platform — optional native packages,
//     case-sensitive resolution, and symlink realpaths all vary between a
//     contributor's laptop and the Linux runner.
//
// So graph.json records the workspace graph only, sorted, with dependency
// metadata (`dependencyTypes`, `dynamic`, `circular`, …) preserved for those
// edges. The npm edges still reach the rule engine during `graph:validate`,
// which is where they are enforced; they are simply not part of the committed
// artifact, because their content is a property of the machine.
const portableModules = local.map((m) => ({
  ...m,
  dependencies: (m.dependencies ?? [])
    .filter((d) => !d.coreModule && isLocal(d.resolved))
    .sort((a, b) => a.resolved.localeCompare(b.resolved)),
  dependents: (m.dependents ?? []).filter(isLocal).sort((a, b) => a.localeCompare(b)),
}));

const graph = {
  ...cruise,
  modules: portableModules,
  summary: {
    ...cruise.summary,
    // The raw totals count the node_modules leaves, whose number depends on
    // the platform (optional native packages, symlink realpaths). Report the
    // totals for what this file actually contains.
    totalCruised: portableModules.length,
    totalDependenciesCruised: portableModules.reduce((n, m) => n + m.dependencies.length, 0),
    environment: undefined,
    optionsUsed: { ...cruise.summary?.optionsUsed, baseDir: undefined },
  },
};

const graphJson = JSON.stringify(graph, null, 2);

// Fail loudly rather than committing an artifact that will make every pull
// request's drift check fail for a reason nobody can see in a binary diff.
// Only path values are checked: the literal string "node_modules" is expected
// inside `optionsUsed.doNotFollow` and `exclude`, where it is configuration
// rather than a machine-dependent path.
const pathsEmitted = portableModules.flatMap((m) => [
  m.source,
  ...m.dependencies.map((d) => d.resolved),
  ...m.dependents,
]);

for (const [what, offends] of [
  ['a node_modules path', (p) => p.includes('node_modules')],
  ['an absolute path', (p) => /^([A-Za-z]:|\/)/.test(p)],
  ['a Windows path separator', (p) => p.includes('\\')],
]) {
  const bad = pathsEmitted.find(offends);
  if (bad !== undefined) {
    console.error(`project-graph: refusing to write graph.json — ${bad} is ${what}.`);
    console.error('project-graph: the committed graph must not depend on the machine.');
    process.exit(1);
  }
}

writeFileSync(join(OUT, 'graph.json'), graphJson);

// --- Condensed index -------------------------------------------------------

const dependsOn = new Map(); // file -> [files it imports]
const dependedOnBy = new Map(); // file -> [files that import it]

for (const m of local) {
  // Keep local edges only: core modules and node_modules are noise for a
  // blast-radius report. Dynamic imports are kept — they are still couplings.
  const deps = (m.dependencies ?? [])
    .filter((d) => !d.coreModule && !d.resolved.includes('node_modules'))
    .map((d) => d.resolved)
    .sort((a, b) => a.localeCompare(b));
  dependsOn.set(m.source, deps);
  for (const d of deps) {
    if (!dependedOnBy.has(d)) dependedOnBy.set(d, []);
    dependedOnBy.get(d).push(m.source);
  }
}

const files = {};
for (const m of local) {
  const src = m.source;
  const reverse = (dependedOnBy.get(src) ?? []).slice().sort((a, b) => a.localeCompare(b));
  files[src] = {
    workspace: workspaceOf(src),
    module: moduleOf(src),
    isTest: isTest(src),
    dependsOn: dependsOn.get(src) ?? [],
    dependedOnBy: reverse,
    // Which test files (transitively one hop) exercise this file.
    coveredByTests: reverse.filter(isTest),
    orphan: Boolean(m.orphan),
  };
}

const unsortedByWorkspace = {};
for (const [src, info] of Object.entries(files)) {
  unsortedByWorkspace[info.workspace] ??= { files: 0, tests: 0, untested: [] };
  unsortedByWorkspace[info.workspace].files += 1;
  if (info.isTest) unsortedByWorkspace[info.workspace].tests += 1;
  else if (info.coveredByTests.length === 0) unsortedByWorkspace[info.workspace].untested.push(src);
}

const byWorkspace = Object.fromEntries(
  Object.entries(unsortedByWorkspace)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ws, s]) => [
      ws,
      { ...s, untested: s.untested.slice().sort((a, b) => a.localeCompare(b)) },
    ]),
);

const violations = (cruise.summary?.violations ?? [])
  .map((v) => ({
    rule: v.rule.name,
    severity: v.rule.severity,
    from: v.from,
    to: v.to,
  }))
  .sort((a, b) => `${a.rule}${a.from}${a.to}`.localeCompare(`${b.rule}${b.from}${b.to}`));

// No timestamp, and every collection is sorted. The output is committed, so it
// must be a pure function of the source tree: CI regenerates it and fails on a
// non-empty `git diff`. A clock reading here would make that check fire on
// every run and therefore mean nothing.
const index = {
  scanned: SCAN_TARGETS,
  totals: {
    files: local.length,
    tests: local.filter((m) => isTest(m.source)).length,
    violations: violations.length,
  },
  byWorkspace,
  violations,
  files,
};

writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2));

// --- Markdown summary ------------------------------------------------------
const wsRows = Object.entries(byWorkspace)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([ws, s]) => `| \`${ws}\` | ${s.files} | ${s.tests} | ${s.untested.length} |`)
  .join('\n');

const md = `# TezUsta project graph

<!-- GENERATED FILE — do not edit. Run \`pnpm graph\` to regenerate. -->

Scanned: ${SCAN_TARGETS.join(', ')}

## Totals

- Files: **${index.totals.files}**
- Test files: **${index.totals.tests}**
- Architecture rule violations: **${index.totals.violations}**

## Workspaces

| Workspace | Files | Tests | Files with no direct test |
| --- | ---: | ---: | ---: |
${wsRows || '| _(empty — no source yet)_ | 0 | 0 | 0 |'}

## Architecture rule violations

${
  violations.length === 0
    ? '_None._'
    : violations
        .map((v) => `- **${v.rule}** (${v.severity}): \`${v.from}\` → \`${v.to}\``)
        .join('\n')
}

## How to query this graph

\`\`\`bash
pnpm graph                                  # regenerate
node tools/project-graph/query.mjs <path>   # impact of changing a file
\`\`\`

\`output/index.json\` is the machine-readable source of truth. For any file it
records \`dependsOn\`, \`dependedOnBy\`, \`coveredByTests\`, and its owning
workspace/module — read that instead of crawling the repository.
`;

writeFileSync(join(OUT, 'GRAPH.md'), md);

console.log(
  `project-graph: ${index.totals.files} files, ${index.totals.tests} tests, ${index.totals.violations} violations`,
);
console.log(`project-graph: wrote ${relative(ROOT, OUT)}/{graph.json,index.json,GRAPH.md}`);
