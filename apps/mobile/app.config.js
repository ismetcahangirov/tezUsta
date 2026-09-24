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
    // **Background, now that there is an accept to ask at** (#171). The
    // entitlement is declared because the app uses it — a background session
    // runs from accept until the order ends (`MasterWorkProvider`) — and it is
    // *requested* only then, never at onboarding (`realtime-architecture.md`
    // § Background location):
    //
    // - `isAndroidBackgroundLocationEnabled` adds `ACCESS_BACKGROUND_LOCATION`;
    //   the plugin defaults `isAndroidForegroundServiceEnabled` to the same
    //   value, adding `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_LOCATION`,
    //   which Android 14 requires for a location service. It is stated rather
    //   than left to that default so the manifest is readable from here.
    // - `isIosBackgroundLocationEnabled` adds `location` to `UIBackgroundModes`.
    // - `locationAlwaysAndWhenInUsePermission` is the string iOS shows when
    //   the app asks for "Always". It says what it is for and when it stops,
    //   because App Review reads it and so does the master.
    //
    // `locationAlwaysPermission` and `motionUsagePermission` stay `false`:
    // `NSLocationAlwaysUsageDescription` is the pre-iOS 11 key for a request
    // this app never makes, and the motion sensor is untouched. `false` is
    // documented in the plugin's options type as "remove the permission".
    // Verified against the introspected native config rather than assumed
    // (`npx expo config --type introspect`).
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'TezUsta sizə yaxın sifarişləri göndərmək və müştəriyə yolda olduğunuzu göstərmək üçün məkanınızdan istifadə edir.',
        locationAlwaysAndWhenInUsePermission:
          'Sifarişdə olarkən telefon kilidli olsa belə müştəri yolda olduğunuzu görsün deyə TezUsta məkanınızdan arxa planda istifadə edir. Sifariş bitən kimi dayanır.',
        locationAlwaysPermission: false,
        motionUsagePermission: false,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
        isIosBackgroundLocationEnabled: true,
      },
    ],
    // The microphone, for in-app voice calls (#187, ADR-0039 § 2). Asked on
    // accept or on tapping call, never at launch (`useMicrophonePermission`).
    //
    // - `microphonePermission` is `NSMicrophoneUsageDescription`: without it
    //   iOS terminates the app the moment the permission is requested.
    //   PLACEHOLDER copy, like the rest of the call surface (ADR-0040 § 7).
    // - `recordAudioAndroid` adds `RECORD_AUDIO`, the permission itself.
    // - Both background options are stated `false` rather than left to the
    //   plugin's defaults: `enableBackgroundPlayback` defaults to **true** in
    //   `expo-audio@57.0.5` (`plugin/build/withAudio.js`) and would add
    //   `UIBackgroundModes: audio`, a media-playback foreground service and its
    //   permissions for a feature this app does not have. Whether a call keeps
    //   running in the background is the room bridge's decision, taken with a
    //   device in hand (#183), not a side effect of a permission prompt.
    [
      'expo-audio',
      {
        microphonePermission:
          'TezUsta sifariş üzrə usta ilə müştəri arasında səsli zəng üçün mikrofondan istifadə edir.',
        recordAudioAndroid: true,
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
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
