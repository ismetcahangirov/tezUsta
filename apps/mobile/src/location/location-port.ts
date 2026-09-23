import type { LocationPermission } from './location-permission';

/** One position, in the only shape this app carries it in. */
export interface Position {
  readonly latitude: number;
  readonly longitude: number;
}

export interface WatchOptions {
  /**
   * How far the phone must move to earn an extra report, in metres, or `null`
   * for no surplus at all. Applied by the platform, not by us — on Android and
   * iOS alike `distanceInterval` filters below the JS thread, which is the
   * whole reason the surplus is cheap.
   */
  readonly distanceMeters: number | null;
  /** Whether this state is worth a GNSS fix — see `location-budget.ts`. */
  readonly needsFreshFix: boolean;
  /**
   * Keep delivering while the app is in the background (issue #171).
   *
   * Only ever true while the master is on a job **and** has granted
   * background access. It is what turns the subscription into a platform
   * background session — an Android foreground service with its ongoing
   * notification, an iOS background location session — and removing the
   * subscription is what ends it, which is how "background updates stop the
   * moment the order ends" is kept.
   */
  readonly background: boolean;
}

export interface WatchSubscription {
  /**
   * Stop. May be asynchronous — ending a background session is a native round
   * trip — and the reporter waits for it before starting the next mode.
   */
  remove(): void | Promise<void>;
}

/**
 * Everything the reporter needs from the platform, and nothing else
 * (issue #171).
 *
 * **An interface rather than `expo-location` itself.** The reporter is a state
 * machine with timers and a backoff, and none of that is easier to test
 * against a native module — `location-adapter.ts` is the only file in the app
 * that imports the vendor, so the tests drive a fake and the mocking happens
 * at this boundary rather than at `jest.mock('expo-location')` in five files.
 *
 * It is also what CLAUDE.md §2 asks for: the interface is designed as if it
 * were already a package, so no vendor type crosses it.
 */
export interface LocationPort {
  /** What the app may currently do, without prompting. */
  permission(): Promise<LocationPermission>;
  /** Prompt, once. Returns what the answer leaves the app able to do. */
  requestPermission(): Promise<LocationPermission>;
  /** Background access, without prompting (issue #171). */
  backgroundPermission(): Promise<LocationPermission>;
  /**
   * Ask for background access. **Only at accept** — never at onboarding,
   * where it gets denied (`realtime-architecture.md` § Background location).
   */
  requestBackgroundPermission(): Promise<LocationPermission>;
  /**
   * The cheapest position that is still true — the platform's last known fix,
   * or `null` if it holds none.
   *
   * **The floor's normal source.** For a master parked at home the last known
   * position is the right answer, and the expensive part of a report on a
   * mid-range Android is the fix rather than the request.
   */
  lastKnown(): Promise<Position | null>;
  /** A fresh fix. Only where the budget says a state is worth one. */
  current(): Promise<Position>;
  /**
   * Subscribe to movement past `distanceMeters`. Rejects when permission is
   * missing, which is how a denial reaches the reporter as a state rather than
   * as a crash.
   */
  watch(options: WatchOptions, onMoved: (position: Position) => void): Promise<WatchSubscription>;
}
