/**
 * Where "now" comes from, for code whose behaviour depends on a boundary in
 * time.
 *
 * Injected rather than read from `new Date()` so a test can stand exactly on
 * a period end or a grace end instead of sleeping towards it (issue #322).
 * Code that only stamps a row can keep calling `new Date()`; this is for code
 * that *decides* something by comparing against the time.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

export const systemClock: Clock = Object.freeze({
  now: () => new Date(),
});
