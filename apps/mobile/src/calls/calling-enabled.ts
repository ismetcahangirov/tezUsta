/**
 * Whether this build lets anybody place or answer a call.
 *
 * **`false` until the room bridge lands**
 * ([ADR-0039](../../../../docs/decisions/ADR-0039-call-surfaces-and-ring-push-ahead-of-the-spike.md)
 * § 3). The screens, the routes and the ring listener are all here and all
 * tested, but nothing connects a call to media yet: an answered call would sit
 * in `connecting` forever, and a visibly broken feature is worse than an
 * absent one. So while this is `false` every entry point renders nothing and
 * the root ignores a ring.
 *
 * **The room bridge's pull request flips it**, together with wiring mute and
 * speaker to the room and running the two-device checks #187 and #188 list.
 * A constant rather than a remote switch, because the missing half is a native
 * module: no server flag could turn it on in a build that does not have it.
 *
 * Its own module so a test can force it on with `jest.mock` without touching
 * anything else — the only reason this is not a line in `index.ts`.
 */
export const CALLING_ENABLED = false;
