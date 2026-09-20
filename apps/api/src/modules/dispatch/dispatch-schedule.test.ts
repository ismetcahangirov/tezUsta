import { describe, expect, it } from 'vitest';

import type { DispatchTimings } from './dispatch-schedule';
import {
  currentDispatchRadiusM,
  dispatchDeadline,
  dispatchRadiusForRound,
  dispatchRoundAtElapsed,
  dispatchWaveCount,
  dispatchWavePlan,
  offerExpiresAt,
} from './dispatch-schedule';

/**
 * The shipped defaults, transcribed from `env.schema.ts` rather than imported,
 * for the reason `order-lifecycle.test.ts` transcribes ADR-0015's table: a test
 * that read the same constant the code reads would agree with a typo.
 */
const SHIPPED: DispatchTimings = {
  initialRadiusM: 3000,
  maxRadiusM: 10_000,
  radiusStepSeconds: 30,
  totalTimeoutSeconds: 180,
};

/** What the integration suites turn the clock down to, so seconds become a test. */
const FAST: DispatchTimings = {
  initialRadiusM: 1000,
  maxRadiusM: 4000,
  radiusStepSeconds: 1,
  totalTimeoutSeconds: 3,
};

const SEARCHING_SINCE = new Date('2026-09-19T10:00:00.000Z');

function at(secondsAfterSearchingSince: number): Date {
  return new Date(SEARCHING_SINCE.getTime() + secondsAfterSearchingSince * 1000);
}

describe('the dispatch wave plan', () => {
  it('broadcasts once per radius step across the whole search window', () => {
    // 180s / 30s. Wave 1 fires at t=0, so the last one is at t=150 and the
    // deadline at t=180 belongs to the give-up tick, not to a wave.
    expect(dispatchWaveCount(SHIPPED)).toBe(6);
    expect(dispatchWavePlan(SHIPPED).map((wave) => wave.offsetMs)).toEqual([
      0, 30_000, 60_000, 90_000, 120_000, 150_000,
    ]);
  });

  it('starts at the configured initial radius and ends at exactly the maximum', () => {
    const radii = dispatchWavePlan(SHIPPED).map((wave) => wave.radiusM);

    expect(radii[0]).toBe(SHIPPED.initialRadiusM);
    expect(radii.at(-1)).toBe(SHIPPED.maxRadiusM);
    expect(radii).toEqual([3000, 4400, 5800, 7200, 8600, 10_000]);
  });

  it('never exceeds DISPATCH_MAX_RADIUS_M, including past the last round', () => {
    for (const round of [1, 2, 3, 4, 5, 6, 7, 99]) {
      expect(dispatchRadiusForRound(round, SHIPPED)).toBeLessThanOrEqual(SHIPPED.maxRadiusM);
    }
    // Asking past the plan is the last wave's radius, not a wider one.
    expect(dispatchRadiusForRound(99, SHIPPED)).toBe(SHIPPED.maxRadiusM);
  });

  it('widens monotonically', () => {
    const radii = dispatchWavePlan(SHIPPED).map((wave) => wave.radiusM);

    for (let index = 1; index < radii.length; index += 1) {
      expect(radii[index] ?? 0).toBeGreaterThan(radii[index - 1] ?? 0);
    }
  });

  it('stays at the initial radius when the window holds only one wave', () => {
    const single: DispatchTimings = { ...SHIPPED, radiusStepSeconds: 300 };

    expect(dispatchWaveCount(single)).toBe(1);
    expect(dispatchWavePlan(single)).toEqual([{ round: 1, offsetMs: 0, radiusM: 3000 }]);
  });

  it('adds a final shorter wave when the step does not divide the window evenly', () => {
    // 100 / 30 is 3.33: three full intervals and a 10-second remainder, and an
    // order still searching in that remainder gets one more broadcast.
    const uneven: DispatchTimings = { ...SHIPPED, totalTimeoutSeconds: 100 };

    expect(dispatchWaveCount(uneven)).toBe(4);
    expect(dispatchWavePlan(uneven).map((wave) => wave.offsetMs)).toEqual([
      0, 30_000, 60_000, 90_000,
    ]);
  });

  it('clamps a configuration whose initial radius is wider than its maximum', () => {
    const backwards: DispatchTimings = { ...SHIPPED, initialRadiusM: 50_000 };

    for (const wave of dispatchWavePlan(backwards)) {
      expect(wave.radiusM).toBe(SHIPPED.maxRadiusM);
    }
  });

  it('turns down to seconds without changing shape', () => {
    expect(dispatchWavePlan(FAST)).toEqual([
      { round: 1, offsetMs: 0, radiusM: 1000 },
      { round: 2, offsetMs: 1000, radiusM: 2500 },
      { round: 3, offsetMs: 2000, radiusM: 4000 },
    ]);
  });
});

describe('the round the clock implies', () => {
  it('is round one from the moment the order starts searching', () => {
    expect(dispatchRoundAtElapsed(0, SHIPPED)).toBe(1);
    expect(dispatchRoundAtElapsed(29_999, SHIPPED)).toBe(1);
  });

  it('advances exactly on each step boundary', () => {
    expect(dispatchRoundAtElapsed(30_000, SHIPPED)).toBe(2);
    expect(dispatchRoundAtElapsed(60_000, SHIPPED)).toBe(3);
    expect(dispatchRoundAtElapsed(150_000, SHIPPED)).toBe(6);
  });

  it('never runs past the last wave, however late the tick is', () => {
    // A tick delayed well past the deadline still names a real round, so a
    // reader bounding itself by the clock cannot be handed a radius that does
    // not exist in the plan.
    expect(dispatchRoundAtElapsed(10 * 60 * 1000, SHIPPED)).toBe(6);
  });

  it('treats clock skew backwards as the first round rather than a negative one', () => {
    expect(dispatchRoundAtElapsed(-5000, SHIPPED)).toBe(1);
    expect(dispatchRoundAtElapsed(Number.NaN, SHIPPED)).toBe(1);
  });

  it('gives a delayed tick the radius the clock implies, not its scheduled one', () => {
    // A wave scheduled for t=30 that a busy worker only runs at t=95 must
    // broadcast round 4's circle — the search has genuinely widened that far —
    // rather than round 2's, which would skip masters already in range.
    expect(currentDispatchRadiusM(SEARCHING_SINCE, at(95), SHIPPED)).toBe(7200);
    expect(currentDispatchRadiusM(SEARCHING_SINCE, at(0), SHIPPED)).toBe(3000);
    expect(currentDispatchRadiusM(SEARCHING_SINCE, at(150), SHIPPED)).toBe(10_000);
  });
});

describe('the search deadline and offer expiry', () => {
  it('gives up exactly DISPATCH_TOTAL_TIMEOUT_SECONDS after the search began', () => {
    expect(dispatchDeadline(SEARCHING_SINCE, SHIPPED)).toEqual(at(180));
  });

  it('keeps an offer live for one wave interval', () => {
    expect(offerExpiresAt(at(0), SEARCHING_SINCE, SHIPPED)).toEqual(at(30));
    expect(offerExpiresAt(at(60), SEARCHING_SINCE, SHIPPED)).toEqual(at(90));
  });

  it('never lets an offer outlive the search it belongs to', () => {
    // The final wave fires at t=150 and one interval would land exactly on the
    // deadline; a wave that ran late must still not mint an offer past it.
    expect(offerExpiresAt(at(150), SEARCHING_SINCE, SHIPPED)).toEqual(at(180));
    expect(offerExpiresAt(at(175), SEARCHING_SINCE, SHIPPED)).toEqual(at(180));
  });
});
