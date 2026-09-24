/**
 * The ring push, read without the vendor (#189, ADR-0039 § 4–6).
 *
 * Pure functions over a notification's `data`, so the foreground decision and
 * the dismissal match can be tested without loading `expo-notifications` — a
 * module that throws in Expo Go on Android (`push-adapter.ts`).
 */

/** The kind the server raises for a ringing call. */
export const CALL_RING_KIND = 'call-incoming';

/**
 * What a call id may look like before it is put in a request path. The
 * server's ids are UUIDs; this is looser than that on purpose (a format change
 * server-side should not silently break rings) but tight enough that nothing
 * from a payload can steer the path: no slash, no dot, no query.
 */
const CALL_ID_SHAPE = /^[0-9A-Za-z-]{1,64}$/;

/** A payload field as a call id, or `null` when it is not shaped like one. */
export function readCallId(value: unknown): string | null {
  return typeof value === 'string' && CALL_ID_SHAPE.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a notification's data is a ring push for `callId`. */
export function isRingFor(data: unknown, callId: string): boolean {
  return isRecord(data) && data.kind === CALL_RING_KIND && data.callId === callId;
}

/** Expo's presentation answer, restated so this file imports nothing. */
export interface ForegroundPresentation {
  readonly shouldShowBanner: boolean;
  readonly shouldShowList: boolean;
  readonly shouldPlaySound: boolean;
  readonly shouldSetBadge: false;
}

const SHOWN: ForegroundPresentation = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

const SILENT: ForegroundPresentation = {
  shouldShowBanner: false,
  // Kept in the tray: if both the socket's ring and the confirmation read
  // fail, the notification is the one way back to the call. The dismissal
  // path takes it down once the call is over.
  shouldShowList: true,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

/**
 * How a notification arriving while the app is open is presented.
 *
 * **A ring push is silent in the foreground** — no banner, no sound, but still
 * listed in the tray — while calling is on: the app is
 * open, so the ring is the in-app incoming screen — reached from the socket's
 * `call:incoming`, or from this very push once it is confirmed with the server.
 * A MAX-importance heads-up with the channel's sound on top of that would ring
 * the phone twice. With calling off nothing in the app would ring, so the
 * notification is shown as it always was.
 */
export function foregroundPresentationFor(
  data: unknown,
  callingEnabled: boolean,
): ForegroundPresentation {
  return callingEnabled && isRecord(data) && data.kind === CALL_RING_KIND ? SILENT : SHOWN;
}
