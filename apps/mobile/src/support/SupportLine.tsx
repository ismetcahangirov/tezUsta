import { Linking, Pressable, View } from 'react-native';

import { Text } from '../components';
import { SUPPORT_EMAIL, supportMailUrl } from './support-contact';
import { SUPPORT_COPY as copy } from './support-copy';

export interface SupportLineProps {
  /** Defaults to the configured address; a test passes its own. */
  readonly email?: string | null;
  /** `on-inverse` on the dark sign-in surface. */
  readonly tone?: 'default' | 'on-inverse';
}

/**
 * Where a user who can no longer read their address gets help (ADR-0074
 * § 6, #516). Signed out, they cannot reach any screen inside the app, so the
 * sign-in screen is the only place this can be said.
 *
 * **Renders nothing while the support address is unset**, so the line ships
 * dark until the domain exists (#498, #505) instead of showing an address
 * nobody reads.
 */
export function SupportLine({
  email = SUPPORT_EMAIL,
  tone = 'default',
}: SupportLineProps): React.JSX.Element | null {
  if (email === null) {
    return null;
  }

  const dark = tone === 'on-inverse';

  return (
    <View className="items-center gap-1">
      <Text
        variant="caption"
        tone={dark ? 'on-inverse' : 'muted'}
        className={dark ? 'dark:text-text' : ''}
      >
        {copy.lostAccess}
      </Text>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={copy.writeToLabel(email)}
        hitSlop={8}
        onPress={() => {
          // A phone with no mail app refuses the URL; there is nothing better
          // to offer than the address already on screen.
          void Linking.openURL(supportMailUrl(email)).catch(() => undefined);
        }}
      >
        <Text
          variant="body-strong"
          tone={dark ? 'on-inverse' : 'default'}
          className={dark ? 'underline dark:text-text' : 'underline'}
        >
          {copy.writeTo(email)}
        </Text>
      </Pressable>
    </View>
  );
}
