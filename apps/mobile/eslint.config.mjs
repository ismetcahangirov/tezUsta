import base from '@tezusta/eslint-config/base';

export default [
  {
    ignores: ['.expo/**', 'storybook-static/**', 'coverage/**', '*.config.js', 'global.css'],
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
