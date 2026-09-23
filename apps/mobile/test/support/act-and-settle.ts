import { act } from '@testing-library/react-native';

/**
 * Runs a synchronous action that causes React work, and waits for the work to
 * settle.
 *
 * **Every `act` must be awaited under React 19.** An un-awaited `act(() => …)`
 * leaves its scope open, and the *next* `render` in the same file never
 * commits — every test after the first one then renders nothing at all, with
 * no error anywhere to say why. The symptom points nowhere near the cause,
 * which is why this is a named helper rather than a convention.
 *
 * The `await` inside is what makes the callback legitimately `async` (and
 * satisfies `require-await`); the microtask it yields is where React flushes
 * the effects the action scheduled.
 *
 * Use it for anything a *server* did — a socket frame arriving, a connection
 * dropping — which is to say anything React did not start itself.
 */
export async function actAndSettle(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}
