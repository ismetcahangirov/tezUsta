import { useEffect } from 'react';

import { useRealtimeConnection } from '../realtime';

import { dismissCallNotifications } from './push-adapter';

/**
 * Takes a call's ring notification down the moment any frame says the call is
 * no longer ringing (ADR-0039 § 6, #189) — answered, declined, cancelled, timed
 * out, busy or ended, on this phone or another.
 *
 * **Every call id, not only the one ringing on screen.** A push can be sitting
 * in the tray for a call the app never showed — it was opened from the
 * launcher, not from the notification — and the frames still reach it,
 * because they go to every device the account holds.
 *
 * Here rather than in `calls`, so the dependency points one way:
 * notifications know about calls, calls know nothing about notifications.
 * Mounted once at the root, inside the app's one connection; renders nothing.
 */
export function RingNotificationDismissal(): null {
  const connection = useRealtimeConnection();

  useEffect(() => {
    if (connection === null) {
      return;
    }
    return connection.subscribeToCalls((frame) => {
      if (frame.name !== 'call:incoming') {
        void dismissCallNotifications(frame.payload.call.id);
      }
    });
  }, [connection]);

  return null;
}
