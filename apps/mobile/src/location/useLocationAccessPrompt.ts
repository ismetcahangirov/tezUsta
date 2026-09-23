import { useCallback } from 'react';

import { locationAdapter } from './location-adapter';
import type { LocationPort } from './location-port';

/**
 * Asks for foreground location, from the one call site that has earned it
 * (issue #171).
 *
 * **The moment is the toggle going online, and only that.** A master turning
 * themselves on is asking to be offered work, and dispatch cannot offer work
 * to a master whose position it does not have — so the question has an answer
 * the master can see the point of. Asked at onboarding it is a stranger's app
 * wanting to know where they live, and a denial there is usually permanent.
 * The same rule `usePushAccessPrompt` follows, for the same reason.
 *
 * **It asks once and never again.** `requestForegroundPermissionsAsync` is a
 * no-op after the first refusal on both platforms, so nothing here has to
 * remember — but nothing here should re-ask on a later toggle either, and the
 * `askable` check is what makes that true rather than relying on the platform.
 *
 * **Background location is not asked for here, and must not be.** It is
 * requested when an order is accepted and never at onboarding
 * (`realtime-architecture.md` § Background location) — and this app has no
 * accept screen yet, so nothing may ask for it at all.
 */
export function useLocationAccessPrompt(port: LocationPort = locationAdapter): () => void {
  return useCallback(() => {
    void (async () => {
      const current = await port.permission();

      if (current !== 'askable') {
        return;
      }

      await port.requestPermission();
    })().catch(() => {
      // A platform that cannot answer is not a reason to fail going online.
      // The reporter degrades to "blocked" on its own and the master is told
      // what that costs them (`AvailabilityCard`).
    });
  }, [port]);
}
