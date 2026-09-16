import base from '@tezusta/eslint-config/base';

export default [
  {
    ignores: [
      '.expo/**',
      'storybook-static/**',
      'coverage/**',
      '*.config.js',
      // Jest's own bootstrap, like the config files above: plain CommonJS that
      // no tsconfig includes, so the type-aware rules have no project to
      // resolve it against.
      'jest.setup.js',
      'global.css',
    ],
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
