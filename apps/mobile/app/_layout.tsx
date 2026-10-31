import '../global.css';
// For its side effect: the background location task has to be defined before
// any component mounts, because the OS may relaunch the app just to deliver a
// location to it (issue #171, `src/location/background-task.ts`).
import '../src/location/background-task';

import { useFonts } from 'expo-font';
import { NavigationBar } from 'expo-navigation-bar';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Provider } from 'react-redux';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import InterBold from '../assets/fonts/Inter-Bold.ttf';
import InterBoldItalic from '../assets/fonts/Inter-BoldItalic.ttf';
import InterItalic from '../assets/fonts/Inter-Italic.ttf';
import InterMedium from '../assets/fonts/Inter-Medium.ttf';
import InterMediumItalic from '../assets/fonts/Inter-MediumItalic.ttf';
import InterRegular from '../assets/fonts/Inter-Regular.ttf';
import InterSemiBold from '../assets/fonts/Inter-SemiBold.ttf';
import InterSemiBoldItalic from '../assets/fonts/Inter-SemiBoldItalic.ttf';

import { useAuthGuard, useRestoreSession } from '../src/auth';
import { CALLING_ENABLED, IncomingCallListener } from '../src/calls';
import { sweepCachedPhotos } from '../src/lib/cached-files';
import {
  configureForegroundPresentation,
  RingNotificationDismissal,
  useNotificationRouting,
  usePushRegistration,
} from '../src/notifications';
import { RealtimeProvider } from '../src/realtime';
import { store } from '../src/store';
import { restoreSchemePreference, typography, useTheme } from '../src/theme';

void SplashScreen.preventAutoHideAsync();

// Module scope, alongside the splash call above and for the same kind of
// reason: a notification that arrives before the tree has rendered is still
// delivered, and Expo hands it to whatever handler is installed at that
// moment. Installed in an effect, it would miss exactly the notification that
// woke the app (`src/notifications/push-adapter.ts`).
configureForegroundPresentation(CALLING_ENABLED);

// The appearance the person chose (light, dark or the phone's), read while the
// fonts load so the first frame is already drawn in it. Never throws: an
// unreadable store leaves the app following the phone.
void restoreSchemePreference();

// Photos an earlier run left in the cache: a message that failed and was
// never resent, or an upload the app was killed during (#458). Module scope,
// because only before anything mounts is no upload of this run using them.
sweepCachedPhotos();

/**
 * Runs the session-wide effects, and renders nothing of its own.
 *
 * It is a component rather than four hook calls in `RootLayout` because all of
 * them read the store, and `RootLayout` is where `<Provider>` is created —
 * calling them there would read a store that is not yet above them in the
 * tree.
 */
function AuthGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  useRestoreSession();
  useAuthGuard();
  // Registers this phone once there is a session, and never prompts from here
  // — the permission question belongs to a call site that has earned it
  // (`usePushAccessPrompt`).
  usePushRegistration();
  // Opens what a tapped notification is about, once the navigator exists and
  // the session has settled. It has to sit beside `useAuthGuard` rather than
  // inside a screen: a cold-start tap arrives before any screen has mounted.
  useNotificationRouting();

  return <>{children}</>;
}

export default function RootLayout(): React.JSX.Element | null {
  const [fontsLoaded, fontError] = useFonts({
    [typography.family.regular]: InterRegular,
    [typography.family.medium]: InterMedium,
    [typography.family.semibold]: InterSemiBold,
    [typography.family.bold]: InterBold,
    [typography.family.italic]: InterItalic,
    [typography.family['medium-italic']]: InterMediumItalic,
    [typography.family['semibold-italic']]: InterSemiBoldItalic,
    [typography.family['bold-italic']]: InterBoldItalic,
  });
  const { scheme, colors } = useTheme();

  useEffect(() => {
    // A font that failed to load must not hold the splash screen forever —
    // the system typeface is a worse experience than a frozen launch is.
    if (fontsLoaded || fontError) {
      void SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <Provider store={store}>
      <SafeAreaProvider>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        {/* Stated like the status bar's, so both bars read the one scheme `useTheme` reports. */}
        <NavigationBar style={scheme === 'dark' ? 'light' : 'dark'} />
        <AuthGate>
          {/*
            One socket for the app, inside the store provider and above the
            router: a connection opened inside a screen would be opened once
            per screen, and each would count against the server's per-account
            connection cap (issue #170). It is below `AuthGate` because it
            reacts to the session that gate establishes.
          */}
          <RealtimeProvider>
            {/*
              Rings reach the person on whatever screen they are on, so the
              listener sits at the root, inside the one connection
              (issue #188, ADR-0040 § 1). It renders nothing.
            */}
            <IncomingCallListener />
            {/* Takes a ring notification down when any frame says its call is over (#189). */}
            <RingNotificationDismissal />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bg },
              }}
            >
              {/*
                A call is presented over everything, full screen, and a swipe
                cannot dismiss a live call (ADR-0040 § 1). Every other route is
                still discovered from the file system.
              */}
              <Stack.Screen
                name="call"
                options={{ presentation: 'fullScreenModal', gestureEnabled: false }}
              />
            </Stack>
          </RealtimeProvider>
        </AuthGate>
      </SafeAreaProvider>
    </Provider>
  );
}
