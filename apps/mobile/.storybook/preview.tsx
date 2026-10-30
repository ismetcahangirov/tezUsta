import '../global.css';

import type { Decorator, Preview } from '@storybook/react-native-web-vite';
import { colorScheme } from 'nativewind';
import { View } from 'react-native';

import InterBold from '../assets/fonts/Inter-Bold.ttf';
import InterBoldItalic from '../assets/fonts/Inter-BoldItalic.ttf';
import InterItalic from '../assets/fonts/Inter-Italic.ttf';
import InterMedium from '../assets/fonts/Inter-Medium.ttf';
import InterMediumItalic from '../assets/fonts/Inter-MediumItalic.ttf';
import InterRegular from '../assets/fonts/Inter-Regular.ttf';
import InterSemiBold from '../assets/fonts/Inter-SemiBold.ttf';
import InterSemiBoldItalic from '../assets/fonts/Inter-SemiBoldItalic.ttf';
import { typography } from '../src/theme/tokens';

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
      font-family: '${typography.family.regular}';
      src: url(${InterRegular}) format('truetype');
      font-display: swap;
    }
    @font-face {
      font-family: '${typography.family.medium}';
      src: url(${InterMedium}) format('truetype');
      font-display: swap;
    }
    @font-face {
      font-family: '${typography.family.semibold}';
      src: url(${InterSemiBold}) format('truetype');
      font-display: swap;
    }
    @font-face {
      font-family: '${typography.family.bold}';
      src: url(${InterBold}) format('truetype');
      font-display: swap;
    }
    @font-face {
      font-family: '${typography.family.italic}';
      src: url(${InterItalic}) format('truetype');
      font-display: swap;
    }
    @font-face {
      font-family: '${typography.family['medium-italic']}';
      src: url(${InterMediumItalic}) format('truetype');
      font-display: swap;
    }
    @font-face {
      font-family: '${typography.family['semibold-italic']}';
      src: url(${InterSemiBoldItalic}) format('truetype');
      font-display: swap;
    }
    @font-face {
      font-family: '${typography.family['bold-italic']}';
      src: url(${InterBoldItalic}) format('truetype');
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
