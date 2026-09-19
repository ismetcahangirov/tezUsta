/**
 * A list of things to undo when the current test finishes.
 *
 * It exists as its own module, importing nothing, for a reason that is easy to
 * rediscover the hard way: **`test/setup-teardown.ts` must not import
 * application code.** A `setupFilesAfterEnv` file is evaluated before the test
 * file, so anything it pulls in is already in the module registry by the time
 * the test file's `jest.mock(...)` factories are installed — and a module that
 * was loaded with the real `expo-secure-store` keeps the real one. Importing
 * the store from the teardown broke five unrelated suites exactly that way.
 *
 * So the teardown knows only how to run a list of callbacks, and the modules
 * the tests themselves import — `test-store.ts`, and whatever comes next —
 * register what they need undone.
 */
const disposals = new Set<() => void>();

/** Register something to undo when the current test ends. */
export function onTestEnd(dispose: () => void): void {
  disposals.add(dispose);
}

/**
 * Runs and forgets every registered disposal, and reports how many there were.
 * The list is cleared before anything runs, so a disposal that throws is still
 * only attempted once.
 */
export function runTestEndDisposals(): number {
  const pending = [...disposals];
  disposals.clear();
  for (const dispose of pending) {
    dispose();
  }
  return pending.length;
}
