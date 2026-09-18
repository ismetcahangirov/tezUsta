// Root ESLint config. It covers repo-root tooling scripts, `tools/*`, and the
// plain-JavaScript files in `packages/*` — the shared ESLint config among them,
// which nothing else lints because those workspaces define no `lint` script and
// contain no TypeScript.
//
// `apps/*` are excluded on purpose: each app lints itself through
// `@tezusta/eslint-config` with the type-aware rules that need its own tsconfig.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'apps/**',
      // Agent worktrees: a full checkout of this repository nested inside it.
      // Without these, ESLint lints a second copy of every workspace and fails
      // resolving `@tezusta/eslint-config` from a `node_modules` that is not
      // there. See the matching entries in .gitignore.
      '.claude/worktrees/**',
      '.kilo/**',
      '**/dist/**',
      '**/.turbo/**',
      'tools/project-graph/output/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['tools/**/*.mjs', 'packages/**/*.mjs', 'packages/**/*.cjs', '*.mjs', '*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['*.cjs', 'packages/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
];
