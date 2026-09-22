import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking } from 'react-native';

import { expoPushPlatform } from './push-adapter';
import type { PushPermission } from './push-permission';

/**
 * What the operating system currently allows, and how to go and change it.
 *
 * **Per-category toggles are meaningless while the OS is blocking everything**,
 * so the settings screen has to say so rather than presenting five switches
 * that cannot do anything. This is the only place in the app that reads the
 * permission without also trying to register — `usePushRegistration` asks
 * because it is about to act on the answer; this asks because it is about to
 * render it.
 *
 * **It re-reads when the app comes back to the foreground**, which is the
 * whole reason it is a hook rather than a value. Changing a notification
 * setting means leaving for the system settings app and returning, and a
 * screen that still said "blocked" afterwards would be telling the user their
 * own change did not work. The same rule the location permission already
 * follows (`docs/architecture/frontend-architecture.md` § Permissions):
 * re-entering from settings is handled without an app restart.
 *
 * `undefined` is "not read yet", and is deliberately distinct from `blocked`:
 * rendering a warning during the first frame of every launch would be a
 * warning nobody trusts.
 */
export function useOsNotificationPermission(): {
  readonly permission: PushPermission | undefined;
  readonly openSystemSettings: () => void;
} {
  const [permission, setPermission] = useState<PushPermission | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const read = (): void => {
      void expoPushPlatform.getPermission().then(
        (next) => {
          if (!cancelled) {
            setPermission(next);
          }
        },
        () => {
          // A platform that cannot answer is not a platform that is blocking.
          // Leaving it unread keeps the warning off a screen that has no
          // evidence for it.
        },
      );
    };

    read();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        read();
      }
    });

    return (): void => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  const openSystemSettings = useCallback(() => {
    // `void`, not awaited: nothing renders differently for having opened, and
    // a rejection on a platform with no settings screen is not the user's
    // problem to see.
    void Linking.openSettings().catch(() => undefined);
  }, []);

  return { permission, openSystemSettings };
}
