// Node/NestJS-specific overrides layered on top of the base config.
import base from './base.mjs';
import globals from 'globals';

/** @type {import('typescript-eslint').ConfigArray} */
export default [
  ...base,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // NestJS relies on parameter decorators and DI classes.
      '@typescript-eslint/no-extraneous-class': 'off',
      // Nest lifecycle hooks are legitimately empty sometimes.
      '@typescript-eslint/no-empty-function': ['error', { allow: ['methods'] }],
    },
  },
];
