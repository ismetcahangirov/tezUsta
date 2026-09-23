import { createRealtimeSocket, RECONNECTION } from './realtime-socket';

/**
 * The reconnection policy the app actually ships (issue #170).
 *
 * **Asserted against the socket's own backoff, not against the constants we
 * passed it.** A test that read `RECONNECTION` back would pass just as happily
 * if `randomizationFactor` were being ignored — and socket.io only applies
 * jitter when the value is inside `0 < jitter <= 1`
 * (`socket.io-client/build/cjs/contrib/backo2.js`), which is exactly the kind
 * of silently-dropped option that a constants check cannot catch.
 *
 * `autoConnect: false` is what makes this safe to run with no server: the
 * manager is built, its backoff is real, and nothing dials.
 */
interface ManagerWithBackoff {
  readonly io: { readonly backoff: { duration(): number; reset(): void } };
}

function backoffOf() {
  const socket = createRealtimeSocket({ getToken: () => 'token', url: 'http://127.0.0.1:1' });
  return (socket as unknown as ManagerWithBackoff).io.backoff;
}

describe('the reconnection backoff', () => {
  it('grows, so a phone does not hammer an API that is still starting', () => {
    const backoff = backoffOf();

    const first = backoff.duration();
    const fourth = [backoff.duration(), backoff.duration(), backoff.duration()].at(-1) ?? 0;

    expect(fourth).toBeGreaterThan(first);
  });

  it('is bounded, so a phone left in a pocket stops retrying every few seconds', () => {
    const backoff = backoffOf();

    const delays = Array.from({ length: 20 }, () => backoff.duration());

    expect(Math.max(...delays)).toBeLessThanOrEqual(RECONNECTION.delayMaxMs);
  });

  /**
   * **The one that matters operationally.** Without jitter an API restart
   * brings every phone back at the same instant — the stampede
   * `realtime-architecture.md` § Connection lifecycle names. Two backoffs at
   * the same attempt count producing the same number over and over is what a
   * dropped `randomizationFactor` looks like.
   */
  it('is jittered, so an API restart is not answered by every phone at once', () => {
    const observed = new Set<number>();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const backoff = backoffOf();
      // The second duration: large enough that a 50% deviation spans many
      // milliseconds, and still far below the ceiling that would clamp it.
      backoff.duration();
      observed.add(backoff.duration());
    }

    expect(observed.size).toBeGreaterThan(1);
  });
});
