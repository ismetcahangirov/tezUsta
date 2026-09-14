/**
 * TezUsta architecture rules + dependency graph configuration.
 *
 * Two jobs:
 *   1. `pnpm graph`          — emit the machine-readable graph (tools/project-graph).
 *   2. `pnpm graph:validate` — fail CI when an architectural boundary is crossed.
 *
 * The rules here encode the boundaries documented in
 * docs/architecture/architecture-overview.md. Adding a rule is cheaper than
 * discovering the violation six months later.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies make modules impossible to reason about or test in isolation.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphan modules are usually dead code left behind by a refactor.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$',
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(babel|metro|jest|tailwind|drizzle|eslint|app)\\.config\\.(js|cjs|mjs|ts)$',
          // tools/* are CLI entry points — nothing imports them by design.
          '^tools/',
          // Storybook finds these by glob, and Expo Router finds routes by file
          // path. Neither is ever imported, and neither is dead code.
          '\\.stories\\.(ts|tsx)$',
          '(^|/)\\.storybook/',
          '^apps/mobile/app/',
        ],
      },
      to: {},
    },
    {
      name: 'no-deprecated-core',
      severity: 'error',
      comment: 'Deprecated Node core modules will be removed in a future runtime.',
      from: {},
      to: { dependencyTypes: ['core'], path: ['^(punycode|domain|sys|constants)$'] },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment:
        'Production code must not import a devDependency — it will be absent in the deployed image.',
      from: {
        path: '^(apps|packages)',
        // Tests, stories, and Storybook config are tooling: they never reach a
        // build, so importing a devDependency from them is correct.
        pathNot:
          '\\.(test|spec)\\.(ts|tsx)$|\\.stories\\.(ts|tsx)$|/test/|/__tests__/|/\\.storybook/',
      },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-non-package-json',
      severity: 'error',
      comment: 'Dependency used but not declared in package.json — breaks on a clean install.',
      from: {},
      to: {
        dependencyTypes: ['unknown', 'undetermined', 'npm-no-pkg', 'npm-unknown'],
        // A workspace package resolves to a path inside the repo. pnpm links
        // those through a symlink and a subpath export, which dependency-cruiser
        // reports as `undetermined` even though package.json declares the
        // dependency. Cross-workspace edges are governed by the boundary rules
        // below, so excluding them here loses no coverage.
        pathNot: '^(apps|packages|tools)/',
      },
    },

    // --- TezUsta boundaries -------------------------------------------------
    {
      name: 'mobile-not-into-api',
      severity: 'error',
      comment:
        'The mobile app must talk to the backend over HTTP/WS only, never import its source. ' +
        'Share contracts through packages/types instead.',
      from: { path: '^apps/mobile' },
      to: { path: '^apps/api' },
    },
    {
      name: 'api-not-into-client',
      severity: 'error',
      comment: 'The backend must never depend on a client application.',
      from: { path: '^apps/api' },
      to: { path: '^apps/(mobile|admin)' },
    },
    {
      name: 'shared-packages-stay-shared',
      severity: 'error',
      comment:
        'packages/* are leaf libraries. A shared package importing an app inverts the dependency ' +
        'direction and makes the package unusable elsewhere.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
  ],

  options: {
    doNotFollow: { path: ['node_modules'] },
    exclude: {
      path: [
        'node_modules',
        '\\.turbo',
        '\\.expo',
        '(^|/)dist/',
        '(^|/)build/',
        '(^|/)coverage/',
        '(^|/)storybook-static/',
        'tools/project-graph/output',
      ],
    },
    includeOnly: '^(apps|packages|tools)/',
    // Follow `import type` edges too — a type-only import is still a coupling
    // that the blast-radius report must show.
    tsPreCompilationDeps: true,
    // Deliberately no `tsConfig` here. tsconfig.base.json is a base to extend,
    // not a buildable project, and pointing tsc at it fails with TS18003.
    // Module resolution goes through node + pnpm workspace links, which is how
    // the apps actually resolve `@tezusta/*`. Revisit only if a workspace
    // introduces tsconfig `paths` aliases that node cannot resolve on its own.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(?:@[^/]+/[^/]+|[^/]+)' },
      archi: {
        collapsePattern:
          '^(?:packages|apps|tools)/[^/]+|^apps/api/src/modules/[^/]+|node_modules/(?:@[^/]+/[^/]+|[^/]+)',
      },
    },
  },
};
