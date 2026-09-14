import '../global.css';

import AnybodyRegular from '@expo-google-fonts/anybody/400Regular/Anybody_400Regular.ttf';
import AnybodyBold from '@expo-google-fonts/anybody/700Bold/Anybody_700Bold.ttf';
import type { Decorator, Preview } from '@storybook/react-native-web-vite';
import { colorScheme } from 'nativewind';
import { View } from 'react-native';

/**
 * On the device `useFonts` registers the typeface. On the web there is no such
 * step, so the same font files — the ones the app actually ships, not a CDN
 * copy that could drift — are registered under the family names the tokens use.
 */
function registerFonts(): void {
  if (typeof document === 'undefined' || document.getElementById('tezusta-fonts')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'tezusta-fonts';
  style.textContent = `
    @font-face {
      font-family: 'Anybody_400Regular';
      src: url(${AnybodyRegular}) format('truetype');
      font-display: swap;
    }
    @font-face {
      font-family: 'Anybody_700Bold';
      src: url(${AnybodyBold}) format('truetype');
      font-display: swap;
    }
  `;
  document.head.appendChild(style);
}

registerFonts();

/**
 * The toolbar theme switch drives NativeWind's colour scheme — the same
 * mechanism the app's settings screen uses. Reviewing a component in both
 * themes is the point of having two of them.
 */
const withTheme: Decorator = (Story, context) => {
  const theme = context.globals.theme === 'dark' ? 'dark' : 'light';
  colorScheme.set(theme);

  return (
    <View className="min-h-control-lg w-full bg-bg p-6">
      <Story />
    </View>
  );
};

const preview: Preview = {
  decorators: [withTheme],

  globalTypes: {
    theme: {
      description: 'Design system colour scheme',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },

  initialGlobals: {
    theme: 'light',
  },

  parameters: {
    controls: { expanded: true },
    options: {
      storySort: {
        order: ['Design System', ['Tokens', 'Typography'], 'Components'],
      },
    },
  },
};

export default preview;
