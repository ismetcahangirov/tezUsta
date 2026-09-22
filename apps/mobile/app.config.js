// Dynamic Expo config so the native shell reads the same design tokens the app
// does. A colour typed twice is a colour that will eventually disagree.
const tokens = require('./src/theme/design-tokens.json');

// Launch and onboarding are the design system's inverse surface
// (docs/design/design-system.md §"Where dark is used").
const launchBackground = tokens.color.dark.bg;

// The tint Android applies to the notification mark (#158).
//
// Read from the tokens for the reason the splash background is: a colour typed
// twice is a colour that will eventually disagree. `light` is not a preference
// here — the accent is the same value in both palettes, and this one is written
// into the manifest at build time, so it cannot follow the device theme however
// it were written.
//
// On Android 12+ this fills the circle the small icon is drawn in and the system
// picks a contrasting foreground itself; on 8–11 it tints the silhouette
// directly, where a pale accent on a light shade is the weaker of the two
// results. The brand colour is still the right value for the brand's slot.
const notificationTint = tokens.color.light.accent;

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
    // `defaultChannel` is the functional half of this entry, not a nicety. The
    // API now addresses a channel per notification category (#157), and FCM v1
    // falls back to the channel named in the manifest — which this option
    // writes — whenever a message names one the phone has not created. That is
    // what a release older than the server's category vocabulary lands on. It
    // has to match `DEFAULT_CHANNEL_ID` in
    // `src/notifications/notification-channels.ts`, which is the table that
    // creates every channel at runtime.
    //
    // `icon` is a 96x96 all-white PNG with transparency, which is what the
    // plugin's own type documents (`expo-notifications@57.0.20`,
    // `plugin/build/withNotifications.d.ts`). Android draws it as a
    // **silhouette**: every non-transparent pixel becomes solid and is then
    // tinted, so a coloured or detailed logo arrives as a white blob. Both
    // values are written into the manifest at build time and **cannot be
    // changed over the air** — a new build is required, which is why they want
    // to land before a store submission rather than after.
    [
      'expo-notifications',
      {
        defaultChannel: 'default',
        icon: './assets/notification-icon.png',
        color: notificationTint,
      },
    ],
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
