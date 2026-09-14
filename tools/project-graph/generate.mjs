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
writeFileSync(join(OUT, 'graph.json'), JSON.stringify(cruise, null, 2));

// --- Condensed index -------------------------------------------------------
const local = modules.filter((m) => !m.coreModule && !m.source.includes('node_modules'));

const dependsOn = new Map(); // file -> [files it imports]
const dependedOnBy = new Map(); // file -> [files that import it]

for (const m of local) {
  // Keep local edges only: core modules and node_modules are noise for a
  // blast-radius report. Dynamic imports are kept — they are still couplings.
  const deps = (m.dependencies ?? [])
    .filter((d) => !d.coreModule && !d.resolved.includes('node_modules'))
    .map((d) => d.resolved);
  dependsOn.set(m.source, deps);
  for (const d of deps) {
    if (!dependedOnBy.has(d)) dependedOnBy.set(d, []);
    dependedOnBy.get(d).push(m.source);
  }
}

const files = {};
for (const m of local) {
  const src = m.source;
  const reverse = dependedOnBy.get(src) ?? [];
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

const byWorkspace = {};
for (const [src, info] of Object.entries(files)) {
  byWorkspace[info.workspace] ??= { files: 0, tests: 0, untested: [] };
  byWorkspace[info.workspace].files += 1;
  if (info.isTest) byWorkspace[info.workspace].tests += 1;
  else if (info.coveredByTests.length === 0) byWorkspace[info.workspace].untested.push(src);
}

const violations = (cruise.summary?.violations ?? []).map((v) => ({
  rule: v.rule.name,
  severity: v.rule.severity,
  from: v.from,
  to: v.to,
}));

const index = {
  generatedAt: new Date().toISOString(),
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

Generated: ${index.generatedAt}
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
