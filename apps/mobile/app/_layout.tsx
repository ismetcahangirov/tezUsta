import '../global.css';

import { Anybody_400Regular, Anybody_700Bold, useFonts } from '@expo-google-fonts/anybody';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Provider } from 'react-redux';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useAuthGuard, useRestoreSession } from '../src/auth';
import { configureForegroundPresentation, usePushRegistration } from '../src/notifications';
import { store } from '../src/store';
import { useTheme } from '../src/theme';

void SplashScreen.preventAutoHideAsync();

// Module scope, alongside the splash call above and for the same kind of
// reason: a notification that arrives before the tree has rendered is still
// delivered, and Expo hands it to whatever handler is installed at that
// moment. Installed in an effect, it would miss exactly the notification that
// woke the app (`src/notifications/push-adapter.ts`).
configureForegroundPresentation();

/**
 * Runs the session-wide effects, and renders nothing of its own.
 *
 * It is a component rather than three hook calls in `RootLayout` because all
 * of them read the store, and `RootLayout` is where `<Provider>` is created —
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

  return <>{children}</>;
}

export default function RootLayout(): React.JSX.Element | null {
  const [fontsLoaded, fontError] = useFonts({ Anybody_400Regular, Anybody_700Bold });
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
        <AuthGate>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.bg },
            }}
          />
        </AuthGate>
      </SafeAreaProvider>
    </Provider>
  );
}
