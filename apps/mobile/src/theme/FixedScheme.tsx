import { vars } from 'nativewind';
import { createContext, useMemo } from 'react';
import { View } from 'react-native';

import { colors, hexToChannels, type ColorRole, type ColorScheme } from './tokens';

/**
 * The scheme a subtree is pinned to, or null when it follows the device.
 * Read by `useTheme`, so an icon or a spinner inside a pinned subtree takes
 * the pinned palette too — not only the NativeWind classes.
 */
export const FixedSchemeContext = createContext<ColorScheme | null>(null);

/**
 * One scheme's colour roles as the CSS variables `tailwind.config.js` emits
 * them under — the same names, the same `r g b` channel form, read from the
 * same token file. Nothing here is a new colour: it is the existing palette,
 * scoped to a subtree.
 */
export function schemeVars(scheme: ColorScheme): Record<`--color-${ColorRole}`, string> {
  return Object.fromEntries(
    Object.entries(colors[scheme]).map(([role, hex]) => [`--color-${role}`, hexToChannels(hex)]),
  ) as Record<`--color-${ColorRole}`, string>;
}

export interface FixedSchemeProps {
  readonly scheme: ColorScheme;
  readonly className?: string;
  readonly children: React.ReactNode;
}

/**
 * Pins a subtree to one scheme whatever the device is set to (ADR-0041).
 *
 * The utility classes resolve through CSS variables (`bg-inverse-surface` is
 * `rgb(var(--color-inverse-surface))`), so re-declaring those variables on a
 * container re-points every class beneath it — NativeWind's `vars()` is the
 * documented way to do that on native and on the web alike. The context does
 * the same for the few places that read colours in JS (`useTheme`).
 *
 * Used by the call surface, which has one appearance in both themes. Not a
 * theme switch: the device's own setting still governs everything outside it.
 */
export function FixedScheme({ scheme, className, children }: FixedSchemeProps): React.JSX.Element {
  const style = useMemo(() => vars(schemeVars(scheme)), [scheme]);

  return (
    <FixedSchemeContext.Provider value={scheme}>
      <View style={style} className={className ?? ''}>
        {children}
      </View>
    </FixedSchemeContext.Provider>
  );
}
