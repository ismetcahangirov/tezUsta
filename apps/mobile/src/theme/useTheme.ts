import { useColorScheme } from 'nativewind';
import { useContext } from 'react';

import { FixedSchemeContext } from './FixedScheme';

import { colors, type ColorRole, type ColorScheme } from './tokens';

export interface Theme {
  scheme: ColorScheme;
  colors: Record<ColorRole, string>;
}

/**
 * The active scheme and its resolved colour values.
 *
 * Components style themselves with NativeWind classes. This hook is for the
 * places a class cannot reach — the status bar, a navigator option, an SVG
 * stroke, a map style.
 */
export function useTheme(): Theme {
  const { colorScheme } = useColorScheme();
  // A subtree pinned to one scheme (`FixedScheme`, the call surface) wins
  // over the device setting, so JS-coloured icons agree with its classes.
  const fixed = useContext(FixedSchemeContext);
  const scheme: ColorScheme = fixed ?? (colorScheme === 'dark' ? 'dark' : 'light');

  return { scheme, colors: colors[scheme] };
}
