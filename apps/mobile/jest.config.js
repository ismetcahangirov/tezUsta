const expoPreset = require('jest-expo/jest-preset');

// Packages that ship untranspiled ESM and are not in jest-expo's own allow-list.
// Extending the preset's patterns rather than replacing them keeps Expo's own
// (carefully ordered) rules intact.
const UNTRANSPILED = [
  'nativewind',
  'react-native-css-interop',
  'react-native-svg',
  'lucide-react-native',
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
  moduleNameMapper: {
    // Metro resolves Lucide's ESM build; Jest's transform only covers
    // `.js/.jsx/.ts/.tsx`, so the `.mjs` barrel arrives untransformed. Node's
    // own resolution picks the CommonJS build, which is also far cheaper to
    // load than transpiling a barrel of a thousand icons per suite.
    '^lucide-react-native$': require.resolve('lucide-react-native'),
  },
  testPathIgnorePatterns: ['/node_modules/', '/.expo/', '/storybook-static/'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.stories.tsx'],
};
