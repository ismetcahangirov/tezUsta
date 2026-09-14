// Dynamic Expo config so the native shell reads the same design tokens the app
// does. A colour typed twice is a colour that will eventually disagree.
const tokens = require('./src/theme/design-tokens.json');

// Launch and onboarding are the design system's inverse surface
// (docs/design/design-system.md §"Where dark is used").
const launchBackground = tokens.color.dark.bg;

/** @type {import('expo/config').ExpoConfig} */
module.exports = {
  name: 'TezUsta',
  slug: 'tezusta',
  scheme: 'tezusta',
  version: '0.1.0',
  orientation: 'portrait',
  // Required for the dark theme to follow the device setting.
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'az.tezusta.app',
  },
  android: {
    package: 'az.tezusta.app',
    edgeToEdgeEnabled: true,
  },
  web: {
    bundler: 'metro',
    output: 'static',
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    ['expo-splash-screen', { backgroundColor: launchBackground, resizeMode: 'contain' }],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    // The app icon, adaptive icon, and splash artwork are still the owner's
    // decision (CLAUDE.md §17). Expo's defaults apply until they are supplied.
    designAssetsPending: true,
  },
};
