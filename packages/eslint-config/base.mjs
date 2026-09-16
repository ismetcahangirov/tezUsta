// Shared flat ESLint config for every TezUsta workspace.
// ESLint 10 uses flat config by default; see docs/engineering/coding-standards.md.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** @type {import('typescript-eslint').ConfigArray} */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      // Agent worktrees: Claude Code checks a full copy of this repository out
      // under .claude/ for an isolated subagent. Without this, `pnpm lint` in
      // the main worktree lints somebody else's tree — and reports failures
      // against files that are not the ones being changed, with the wrong
      // tsconfig project, which is how a green branch appears to be broken.
      // Matches the same exclusion in .gitignore and .prettierignore.
      '**/.claude/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/.expo/**',
      '**/coverage/**',
      // Config files sit outside every tsconfig project, so the type-aware
      // rules cannot parse them.
      '**/*.config.js',
      '**/*.config.cjs',
      '**/eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused vars are errors, except intentionally-prefixed `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Enforce `import type` so runtime imports stay explicit.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Floating promises hide failures in request handlers and queue workers.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // `any` defeats the validation boundary described in docs/engineering/security.md.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Tests may reach for looser typing when building fixtures.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/test/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
