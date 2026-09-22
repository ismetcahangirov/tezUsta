import { useCallback, useEffect } from 'react';

import { useAppDispatch, useAppSelector } from '../store/hooks';
import { selectAuthStatus } from '../store/session-slice';
import type { RegisterDevice } from './device-registration';
import { devicesApi } from './devices-endpoints';
import { addPushTokenRotationListener } from './push-adapter';
import { runPushRegistration } from './push-registration';

/**
 * `POST /devices`, as a plain function rather than a mutation hook.
 *
 * The registration flow is not a render — it is a sequence with a platform
 * ordering in it — so it takes a function it can call, and the component layer
 * is only responsible for binding that function to the store.
 */
function useRegisterDevice(): RegisterDevice {
  const dispatch = useAppDispatch();

  return useCallback(
    (registration) => dispatch(devicesApi.endpoints.registerDevice.initiate(registration)).unwrap(),
    [dispatch],
  );
}

/**
 * Keeps this installation registered for as long as somebody is signed in.
 *
 * Mounted once, in the root layout's `AuthGate`, and it does two things.
 *
 * **It registers silently.** `mayAsk: false`, so a launch never produces a
 * permission dialog: a phone that has already agreed is registered, and one
 * that has not is left alone until a call site earns the question
 * (`usePushAccessPrompt`). That is the whole of the onboarding rule, and it is
 * why this hook and the prompt are separate exports rather than one.
 *
 * **It listens for a rotated token.** A listener rather than a loop — no
 * polling (CLAUDE.md §12) — and a rotation that is never re-registered is a
 * phone that silently stops receiving, which is the failure worth a
 * subscription.
 *
 * Nothing here awaits anything on the way to a screen. A registration that
 * fails is retried on the next launch, and an effect that ran and lost is
 * indistinguishable, from the user's side, from one that never ran.
 */
export function usePushRegistration(): void {
  const status = useAppSelector(selectAuthStatus);
  const register = useRegisterDevice();

  useEffect(() => {
    if (status !== 'signed-in') {
      return;
    }

    // `void`, not `await`: `runPushRegistration` is total, and holding the
    // effect open would hold the render that scheduled it.
    void runPushRegistration(register, { mayAsk: false });

    const subscription = addPushTokenRotationListener(() => {
      void runPushRegistration(register, { mayAsk: false });
    });

    return (): void => {
      subscription.remove();
    };
  }, [status, register]);
}

/**
 * The one place the permission dialog is allowed to come from.
 *
 * **When to call it is an onboarding decision, and it belongs to exactly one
 * moment: the one where the answer is obviously yes.** A customer who has just
 * created an order is waiting to hear that a master took it; a master who has
 * just gone available is waiting to be offered work. Asking at first launch
 * instead spends the question on somebody with no reason to say yes — and on
 * iOS the system prompt is shown once, so a reflex refusal there is permanent.
 *
 * Returned as a callback rather than run by an effect so the trigger point
 * stays visible at the call site. Moving the prompt is then an edit to two
 * lines, not an archaeology exercise (CLAUDE.md §17).
 */
export function usePushAccessPrompt(): () => void {
  const register = useRegisterDevice();

  return useCallback(() => {
    void runPushRegistration(register, { mayAsk: true });
  }, [register]);
}
