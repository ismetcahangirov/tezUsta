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

// The two platform-restricted client map keys (#172, ADR-0035). Read once, so
// the config plugin below and `extra.googleMapsIos` come from one evaluation.
const googleMapsAndroidKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY || undefined;
const googleMapsIosKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY || undefined;

// A store build without a map key ships a map that cannot draw: blank tiles on
// Android, and on iOS Apple Maps where ADR-0004 requires Google. EAS sets
// `EAS_BUILD_PROFILE` on its build workers, so a `production` profile fails
// here, at config evaluation, before a binary exists. No other environment is
// refused — a development build without keys is how the app runs today, and
// this repository has no `eas.json` yet, so `production` is the name EAS gives
// that profile by default rather than one this repository has declared.
if (
  process.env.EAS_BUILD_PROFILE === 'production' &&
  (!googleMapsAndroidKey || !googleMapsIosKey)
) {
  throw new Error(
    'A production build needs EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY and ' +
      'EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY (see .env.example and ADR-0035).',
  );
}

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
    // The usage strings iOS shows in its own permission dialog, and the
    // Android manifest entries (#171).
    //
    // **Not optional and not cosmetic**: an iOS build with no
    // `NSLocationWhenInUseUsageDescription` does not show a dialog, it
    // terminates the app the moment the permission is requested, and App
    // Review rejects a string that does not say what the location is for.
    // Written here rather than in `Info.plist` because the plist is generated.
    //
    // **Foreground only, deliberately.** `isIosBackgroundLocationEnabled` and
    // `isAndroidBackgroundLocationEnabled` stay off: background access is
    // requested when an order is accepted and never at onboarding
    // (`realtime-architecture.md` § Background location), and this app has no
    // accept surface yet. Declaring the background entitlement before anything
    // uses it would put `ACCESS_BACKGROUND_LOCATION` in the manifest and
    // "Always" in the iOS dialog, which is both a store-review question with
    // no answer and a permission the app cannot justify asking for.
    //
    // The three `false`s remove strings the plugin adds by default — `false` is
    // documented in its own options type as "remove the permission". Left in,
    // an iOS build would ship `NSLocationAlwaysUsageDescription` and
    // `NSLocationAlwaysAndWhenInUseUsageDescription` reading "Allow
    // $(PRODUCT_NAME) to access your location" in English, for access this app
    // never requests, and `NSMotionUsageDescription` for a sensor it does not
    // touch. App Review reads those strings; a usage description for a
    // capability the binary never uses is a rejection, not a leftover.
    // Verified against the introspected native config rather than assumed
    // (`npx expo config --type introspect`).
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'TezUsta sizə yaxın sifarişləri göndərmək və müştəriyə yolda olduğunuzu göstərmək üçün məkanınızdan istifadə edir.',
        locationAlwaysAndWhenInUsePermission: false,
        locationAlwaysPermission: false,
        motionUsagePermission: false,
      },
    ],
    // The customer's tracking map (#172, ADR-0035). The plugin writes the
    // Android key into the manifest as `com.google.android.geo.API_KEY` and
    // the iOS key into `Info.plist` as `GMSApiKey`, and installs the Google
    // Maps SDK pod on iOS only when an iOS key is present
    // (`react-native-maps@1.27.2`, `plugin/build/ios.js` and `android.js`).
    //
    // **These are the one documented `EXPO_PUBLIC_` exception** (CLAUDE.md §4,
    // `docs/engineering/security.md`): platform-restricted client keys, scoped
    // to the Maps SDK and locked to `az.tezusta.app`, that ship in the binary
    // because the map cannot draw without them. Read from the environment at
    // build time and never written here — `GOOGLE_MAPS_SERVER_API_KEY` is a
    // different, billable key and must never appear in this file.
    //
    // Unset, both are omitted rather than written as empty strings: Android
    // then draws blank tiles and iOS falls back to Apple Maps in a development
    // build (`src/tracking/map-surface.tsx`). A release build must set both.
    [
      'react-native-maps',
      {
        androidGoogleMapsApiKey: googleMapsAndroidKey,
        iosGoogleMapsApiKey: googleMapsIosKey,
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
    // Whether this build installed the Google Maps SDK on iOS — the plugin
    // does so only with an iOS key. `src/tracking/map-surface.tsx` reads it to
    // pick the provider, so JavaScript and the native project cannot disagree.
    // A boolean on purpose: the key itself is never copied into `extra`.
    googleMapsIos: Boolean(googleMapsIosKey),
  },
};
