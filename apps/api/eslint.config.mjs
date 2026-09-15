import node from '@tezusta/eslint-config/node';

export default [
  {
    ignores: ['dist/**', 'coverage/**'],
  },
  ...node,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
