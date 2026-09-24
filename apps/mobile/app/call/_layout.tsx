import { Stack } from 'expo-router';

/**
 * The call screens (issue #188,
 * [ADR-0040](../../../../docs/decisions/ADR-0040-call-screens.md) § 1).
 *
 * **At the root, not inside either role's group.** A call has to be reachable
 * from anywhere the app is — a ring arrives over an unrelated screen — and
 * either side of an order can place one. The root stack presents this whole
 * directory as a full-screen modal with gestures off (`app/_layout.tsx`); the
 * same holds here, so moving between the two call routes can never be undone
 * by a swipe either.
 *
 * The screens paint their own inverse surface in both themes, so the stack's
 * content background is left to them.
 */
export default function CallLayout(): React.JSX.Element {
  return <Stack screenOptions={{ headerShown: false, gestureEnabled: false }} />;
}
