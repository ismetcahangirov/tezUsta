import {
  registerPushDevice,
  type PushRegistrationOutcome,
  type RegisterDevice,
  type RegistrationOptions,
} from './device-registration';
import { expoPushPlatform } from './push-adapter';
import { registeredDevice } from './registered-device';

/**
 * Registration, wired to the real platform and serialised.
 *
 * **Serialised, not coalesced.** Three things can start a registration — a
 * launch, a sign-in, a rotated token — and two of them can land in the same
 * tick. Running them concurrently would race two `POST /devices` calls for the
 * same token, and coalescing them into one would let a silent launch pass
 * swallow the prompt a call site had earned. Queueing keeps both properties:
 * one at a time, and every caller gets its own answer.
 *
 * It also closes the loop the rotation listener would otherwise make.
 * Acquiring an Expo push token asks the platform for the device token, which
 * is what the listener fires on; a listener that re-entered this function
 * while it was still running would drive itself.
 */
let queue: Promise<unknown> = Promise.resolve();

async function attempt(
  register: RegisterDevice,
  options: RegistrationOptions,
): Promise<PushRegistrationOutcome> {
  const outcome = await registerPushDevice(expoPushPlatform, register, options);

  if (outcome.status === 'registered') {
    registeredDevice.remember({
      id: outcome.device.id,
      expoPushToken: outcome.expoPushToken,
    });
  }

  return outcome;
}

export function runPushRegistration(
  register: RegisterDevice,
  options: RegistrationOptions,
): Promise<PushRegistrationOutcome> {
  const next = queue.then(
    () => attempt(register, options),
    () => attempt(register, options),
  );

  // The queue must not inherit a rejection, or one failed attempt would reject
  // every attempt queued behind it. `attempt` is already total, so this is a
  // belt on top of braces rather than the only guard.
  queue = next.then(
    () => undefined,
    () => undefined,
  );

  return next;
}

/**
 * Retires this installation's device row. Sign-out's first step.
 *
 * **It is not `unregisterForNotificationsAsync()`**, which is the call that
 * looks right and is not: that deletes the device's whole FCM/APNs
 * registration, app-wide — so a customer signing out would silence the master
 * side of the same binary, on the same phone. What sign-out means here is that
 * *this account* is no longer reachable at this address, and that is a row on
 * our server.
 *
 * A failure is swallowed on purpose. The user has asked to sign out; refusing
 * because the network dropped would be the app arguing with them, and the
 * server already retires a device the moment Expo reports it unreachable
 * (issue #142) or somebody else signs in on it (issue #140).
 */
export async function retireRegisteredDevice(
  retire: (deviceId: string) => Promise<void>,
): Promise<void> {
  const device = registeredDevice.current();

  if (device === null) {
    return;
  }

  try {
    await retire(device.id);
  } catch {
    // Deliberately nothing. See above.
  } finally {
    registeredDevice.forget();
  }
}
