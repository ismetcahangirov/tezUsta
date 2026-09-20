const expoPreset = require('jest-expo/jest-preset');

// Packages that ship untranspiled ESM and are not in jest-expo's own allow-list.
// Extending the preset's patterns rather than replacing them keeps Expo's own
// (carefully ordered) rules intact.
const UNTRANSPILED = [
  'nativewind',
  'react-native-css-interop',
  'react-native-svg',
  'lucide-react-native',
  // Redux Toolkit's CommonJS build reaches for the `legacy-esm` files of these
  // two, which are ESM. Without them, importing the store throws
  // `SyntaxError: Unexpected token 'export'` before a single test runs.
  'immer',
  'react-redux',
];

/**
 * Jest matches these patterns against native paths. On Windows a module path is
 * separated by backslashes, so a pattern containing `/node_modules/` never
 * matches and every ESM dependency reaches the runtime untransformed. Matching
 * the separator with `.` accepts both platforms.
 */
function separatorAgnostic(pattern) {
  return pattern.replaceAll('/', '.');
}

const transformIgnorePatterns = expoPreset.transformIgnorePatterns
  .map((pattern) =>
    pattern.includes('(?!(') ? pattern.replace('(?!(', `(?!(${UNTRANSPILED.join('|')}|`) : pattern,
  )
  .map(separatorAgnostic);

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns,
  // Appended to the preset's own setup files rather than replacing them —
  // `setupFiles` is not merged by Jest, and dropping Expo's and React
  // Native's entries removes every native module mock the suite depends on.
  // Ours runs last, before the test framework and before any module is
  // imported, which is what makes it the only place a build-time environment
  // variable can be set (see jest.setup.js).
  setupFiles: [...expoPreset.setupFiles, '<rootDir>/jest.setup.js'],
  // Runs once per test file, after the test framework exists: the suite-wide
  // teardown that unmounts, disposes of every store the test made, and clears
  // whatever timer is still scheduled. Without it a test's leftovers fire into
  // a torn-down environment and hold the worker open (issue #96). See the file
  // itself for why the order of those three steps matters.
  setupFilesAfterEnv: ['<rootDir>/test/setup-teardown.ts'],
  moduleNameMapper: {
    // Metro resolves Lucide's ESM build; Jest's transform only covers
    // `.js/.jsx/.ts/.tsx`, so the `.mjs` barrel arrives untransformed. Node's
    // own resolution picks the CommonJS build, which is also far cheaper to
    // load than transpiling a barrel of a thousand icons per suite.
    '^lucide-react-native$': require.resolve('lucide-react-native'),
  },
  testPathIgnorePatterns: ['/node_modules/', '/.expo/', '/storybook-static/'],
  // Jest's default per-test timeout is 5 seconds, and it is not a budget this
  // suite spends — it is a budget the machine spends. Rendering a React Native
  // tree under jest-expo and waiting for an RTK Query hook to settle is fast on
  // an idle laptop and not fast inside `pnpm verify` on a CI runner, where the
  // API's Postgres-backed suites are saturating the same cores: the same file
  // that finishes in seconds locally has taken 40-55 there, and
  // `ServiceCatalogue.test.tsx` started failing on the 5-second default without
  // anything in the component or the test changing.
  //
  // It was thirty seconds, and part of that was buying headroom for a leak
  // rather than for a slow machine: every test used to leave RTK Query timers
  // and abandoned requests running, and the accumulated work is what pushed a
  // `waitFor` past its deadline on a contended worker (issue #96). With
  // `test/setup-teardown.ts` disposing of that after each test the whole suite
  // dropped from about 160 seconds to about 21. The slowest single test is 2.5
  // idle and 3.3 with the API's thousand Postgres-backed tests saturating the
  // same cores — the file totals stay large because Jest charges a file's
  // module transform to the file, not to any test's budget. The three tests in
  // `ServiceCatalogue.test.tsx` that wait out a real retry backoff keep their
  // own 30-second budgets.
  //
  // Fifteen seconds is a deadline rather than a target: four times the slowest
  // test measured under that contention, still three times the Jest default,
  // and a test that hangs still fails rather than running forever.
  testTimeout: 15_000,
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.stories.tsx'],
  // Coverage is a diagnostic, not a target: no thresholds, so a number can
  // never be gamed into passing CI (docs/engineering/testing-strategy.md).
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
};
