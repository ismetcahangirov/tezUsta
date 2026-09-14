// Root ESLint config. Workspaces extend @tezusta/eslint-config directly;
// this config only covers repo-root tooling scripts.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'apps/**',
      'packages/**',
      '**/dist/**',
      '**/.turbo/**',
      'tools/project-graph/output/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['tools/**/*.mjs', '*.mjs', '*.cjs'],
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
    files: ['*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
];
