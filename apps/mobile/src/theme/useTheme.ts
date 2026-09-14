import { useColorScheme } from 'nativewind';

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
  const scheme: ColorScheme = colorScheme === 'dark' ? 'dark' : 'light';

  return { scheme, colors: colors[scheme] };
}
