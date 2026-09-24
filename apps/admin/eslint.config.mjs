import base from '@tezusta/eslint-config/base';

export default [
  {
    ignores: ['dist/**', 'coverage/**', '*.config.js'],
  },
  ...base,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
