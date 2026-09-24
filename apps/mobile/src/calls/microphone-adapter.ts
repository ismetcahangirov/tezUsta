import type * as ExpoAudio from 'expo-audio';

/**
 * `expo-audio`, loaded on first use rather than at import — the pattern
 * `push-adapter.ts` uses for `expo-notifications`.
 *
 * `calls/index.ts` is imported by the root layout and, since #189, by
 * `notifications`; a static import would evaluate the native module for every
 * one of those importers, including every test that never asks for the
 * microphone, where the module does not load outside a native runtime.
 */
function audio(): typeof ExpoAudio {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded on first use; see the comment above.
  return require('expo-audio') as typeof ExpoAudio;
}

/**
 * The only file in the app that imports `expo-audio`
 * ([ADR-0039](../../../../docs/decisions/ADR-0039-call-surfaces-and-ring-push-ahead-of-the-spike.md)
 * § 2), the way `location-adapter.ts` is the only one that imports
 * `expo-location`.
 *
 * `expo-audio` is here for its permission prompt and nothing else. Recording
 * and playback belong to the media room, which the room bridge owns; nothing
 * in this file touches audio.
 *
 * Resolves `true` only for a granted permission. A refusal, a permission the
 * platform will no longer ask for, and a native call that threw are all
 * `false`: to a call they mean the same thing — it cannot go ahead — and the
 * reducer ends it as `permission_denied` rather than showing an error.
 */
export async function requestMicrophone(): Promise<boolean> {
  try {
    const response = await audio().requestRecordingPermissionsAsync();
    return response.granted;
  } catch {
    return false;
  }
}
