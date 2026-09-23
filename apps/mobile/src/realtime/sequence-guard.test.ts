import { createSequenceGuard } from './sequence-guard';

/**
 * Out-of-order delivery is normal under reconnection, and the guard is what
 * stops it moving a screen backwards (issue #170).
 *
 * The behaviour asserted is "would this event be applied", which is the
 * question every caller actually asks — not the contents of a map.
 */
describe('discarding an event older than one already applied', () => {
  it('admits the first event for a subject, whatever its timestamp', () => {
    const guard = createSequenceGuard();

    expect(guard.admit('order-1', 1_000)).toBe(true);
  });

  it('admits a newer event', () => {
    const guard = createSequenceGuard();
    guard.admit('order-1', 1_000);

    expect(guard.admit('order-1', 1_001)).toBe(true);
  });

  it('discards an older one', () => {
    const guard = createSequenceGuard();
    guard.admit('order-1', 2_000);

    expect(guard.admit('order-1', 1_999)).toBe(false);
  });

  /**
   * `at` is a millisecond timestamp rather than a per-order sequence, so two
   * events genuinely can share one. Dropping the second would lose a real
   * transition to save nothing.
   */
  it('keeps a tie rather than treating it as stale', () => {
    const guard = createSequenceGuard();
    guard.admit('order-1', 2_000);

    expect(guard.admit('order-1', 2_000)).toBe(true);
  });

  it('does not let one subject silence another', () => {
    const guard = createSequenceGuard();
    guard.admit('order-1', 5_000);

    expect(guard.admit('order-2', 1)).toBe(true);
  });

  it('still discards after a subject has gone quiet and come back', () => {
    const guard = createSequenceGuard();
    guard.admit('order-1', 5_000);
    guard.admit('order-2', 9_000);

    expect(guard.admit('order-1', 4_000)).toBe(false);
  });

  it('forgets everything on reset, so a new session starts clean', () => {
    const guard = createSequenceGuard();
    guard.admit('order-1', 9_000);

    guard.reset();

    expect(guard.admit('order-1', 1)).toBe(true);
  });
});
