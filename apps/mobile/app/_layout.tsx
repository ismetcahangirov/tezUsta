import '../global.css';

import { Anybody_400Regular, Anybody_700Bold, useFonts } from '@expo-google-fonts/anybody';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Provider } from 'react-redux';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useAuthGuard, useRestoreSession } from '../src/auth';
import { store } from '../src/store';
import { useTheme } from '../src/theme';

void SplashScreen.preventAutoHideAsync();

/**
 * Runs the two session-wide effects, and renders nothing of its own.
 *
 * It is a component rather than two hook calls in `RootLayout` because both
 * hooks read the store, and `RootLayout` is where `<Provider>` is created —
 * calling them there would read a store that is not yet above them in the
 * tree.
 */
function AuthGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  useRestoreSession();
  useAuthGuard();

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
