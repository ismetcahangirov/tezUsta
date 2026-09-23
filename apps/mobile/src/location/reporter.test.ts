import { LOCATION_BUDGET, RATE_LIMIT_BACKOFF_MS, STALE_AFTER_FLOORS } from './location-budget';
import type { MasterReportingState } from './location-budget';
import type { LocationPort, Position, WatchOptions } from './location-port';
import { createLocationReporter } from './reporter';
import type { LocationReporter, SendOutcome } from './reporter';

const HOME: Position = { latitude: 40.377, longitude: 49.892 };
const DOWN_THE_ROAD: Position = { latitude: 40.378, longitude: 49.893 };

interface Harness {
  readonly port: LocationPort;
  /** The options the last `watch` was started with. */
  watchedWith(): WatchOptions | undefined;
  /** The platform reports movement. */
  move(position: Position): void;
  /** Make `watch` reject, the way a denied permission does. */
  denyPermission(): void;
  /** Whether a subscription is currently live. */
  isWatching(): boolean;
}

/**
 * A platform the test drives, standing in for `expo-location`.
 *
 * The seam is {@link LocationPort}, not a `jest.mock` of the vendor: what
 * needs asserting is a state machine with timers and a backoff, and none of
 * that is easier to provoke through a native module.
 */
function harness(): Harness {
  let denied = false;
  let watching = false;
  let options: WatchOptions | undefined;
  let onMoved: ((position: Position) => void) | undefined;
  let lastKnown: Position | null = HOME;

  return {
    port: {
      permission: () => Promise.resolve('granted'),
      requestPermission: () => Promise.resolve('granted'),
      backgroundPermission: () => Promise.resolve('granted'),
      requestBackgroundPermission: () => Promise.resolve('granted'),
      lastKnown: () => Promise.resolve(lastKnown),
      current: () => Promise.resolve(HOME),
      watch: (watchOptions, moved) => {
        if (denied) {
          return Promise.reject(new Error('permission denied'));
        }
        options = watchOptions;
        onMoved = moved;
        watching = true;
        return Promise.resolve({
          remove: () => {
            watching = false;
          },
        });
      },
    },
    watchedWith: () => options,
    move: (position) => {
      lastKnown = position;
      onMoved?.(position);
    },
    denyPermission: () => {
      denied = true;
    },
    isWatching: () => watching,
  };
}

interface Running {
  readonly app: Harness;
  /** Every position that reached the server, in order. */
  readonly sent: Position[];
  /** What the next send answers with. */
  answerWith(outcome: SendOutcome): void;
  readonly reporter: LocationReporter;
}

function reporterFor(app: Harness): Running {
  const sent: Position[] = [];
  let outcome: SendOutcome = 'sent';

  return {
    app,
    sent,
    answerWith(next) {
      outcome = next;
    },
    reporter: createLocationReporter({
      location: app.port,
      send: (position) => {
        sent.push(position);
        return Promise.resolve(outcome);
      },
      onStatus: () => undefined,
    }),
  };
}

/**
 * Lets every promise the reporter is awaiting settle.
 *
 * A fixed number of microtask turns rather than one: a single floor tick
 * awaits a position, then a send, then the staleness check, so three turns is
 * already too few — and a test that drained too little would assert against a
 * backoff that had not been recorded yet, which is a pass for the wrong
 * reason. Fake timers make this free.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await Promise.resolve();
  }
}

async function running(state: MasterReportingState): Promise<Running> {
  const built = reporterFor(harness());

  await built.reporter.setState(state);
  await settle();

  return built;
}

/**
 * The master's position reporter (issue #171).
 *
 * **The first test is the one the whole file exists for.** ADR-0026 makes the
 * interval a floor rather than a ceiling: while online, a report goes out every
 * interval whether or not the phone moved a metre, because dispatch derives
 * `DISPATCH_MAX_POSITION_AGE_SECONDS` from that floor and a movement-only
 * reporter deletes every parked master from every broadcast.
 */
describe('the location reporter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports with zero movement, on the floor, for as long as the master is online', async () => {
    const { sent, reporter } = await running('online');
    const floorMs = (LOCATION_BUDGET.online?.floorSeconds ?? 0) * 1_000;

    expect(sent).toHaveLength(1);

    for (let beat = 0; beat < 3; beat += 1) {
      jest.advanceTimersByTime(floorMs);
      await settle();
    }

    expect(sent).toHaveLength(4);
    await reporter.stop();
  });

  it('sends the first report at once, not one floor later', async () => {
    const { sent } = await running('online');

    expect(sent).toEqual([HOME]);
  });

  it('asks the platform to filter the surplus by distance, not by time', async () => {
    const { app } = await running('online');

    expect(app.watchedWith()).toEqual({
      distanceMeters: LOCATION_BUDGET.online?.distanceMeters,
      needsFreshFix: false,
      background: false,
    });
  });

  it('reports movement between floors', async () => {
    const { app, sent } = await running('online');

    app.move(DOWN_THE_ROAD);
    await settle();

    expect(sent).toEqual([HOME, DOWN_THE_ROAD]);
  });

  it('reports nothing at all while offline', async () => {
    const { app, sent, reporter } = await running('online');
    sent.length = 0;

    await reporter.setState('offline');
    jest.advanceTimersByTime(600_000);
    await settle();

    expect(sent).toEqual([]);
    expect(app.isWatching()).toBe(false);
  });

  it('retunes to the travelling cadence without stopping', async () => {
    const { app, sent, reporter } = await running('online');

    await reporter.setState('travelling');
    await settle();
    sent.length = 0;

    jest.advanceTimersByTime((LOCATION_BUDGET.travelling?.floorSeconds ?? 0) * 1_000);
    await settle();

    expect(sent).toHaveLength(1);
    expect(app.watchedWith()).toEqual({
      distanceMeters: LOCATION_BUDGET.travelling?.distanceMeters,
      needsFreshFix: true,
      background: false,
    });
  });

  it('does not restart for a state it is already in', async () => {
    const { sent, reporter } = await running('online');
    const before = sent.length;

    await reporter.setState('online');
    await settle();

    expect(sent).toHaveLength(before);
  });

  it('moves the subscription into a background session when the job allows it', async () => {
    const { app, reporter } = await running('online');
    expect(app.watchedWith()?.background).toBe(false);

    await reporter.setState('travelling', { background: true });
    await settle();

    expect(app.watchedWith()).toEqual({
      distanceMeters: LOCATION_BUDGET.travelling?.distanceMeters,
      needsFreshFix: true,
      background: true,
    });
    expect(app.isWatching()).toBe(true);
  });

  it('restarts when background access arrives mid-job, though the state is unchanged', async () => {
    const { app, reporter } = await running('travelling');
    expect(app.watchedWith()?.background).toBe(false);

    await reporter.setState('travelling', { background: true });
    await settle();

    expect(app.watchedWith()?.background).toBe(true);
  });

  it('ends the background session the moment the job does', async () => {
    const { app, reporter } = await running('online');
    await reporter.setState('working', { background: true });
    await settle();
    expect(app.watchedWith()?.background).toBe(true);

    // The job ended: completed, cancelled or re-dispatched all arrive as
    // "online, no background".
    await reporter.setState('online');
    await settle();

    expect(app.watchedWith()?.background).toBe(false);
    expect(app.isWatching()).toBe(true);
  });

  it('never runs a background session while offline, whatever it is asked', async () => {
    const { app, reporter } = await running('travelling');

    await reporter.setState('offline', { background: true });
    await settle();

    expect(app.isWatching()).toBe(false);
    expect(reporter.status().reporting).toBe(false);
  });

  it('leaks nothing when a mode change arrives while the previous one is still starting', async () => {
    // A platform that answers `watch` only when told to — the real one awaits
    // a native round trip, and the job read and the background-access answer
    // routinely arrive a few milliseconds apart.
    const pending: (() => void)[] = [];
    let open = 0;
    const sent: Position[] = [];
    const slow: LocationPort = {
      ...harness().port,
      watch: () =>
        new Promise((resolve) => {
          pending.push(() => {
            open += 1;
            resolve({
              remove: () => {
                open -= 1;
              },
            });
          });
        }),
    };
    const reporter = createLocationReporter({
      location: slow,
      send: (position) => {
        sent.push(position);
        return Promise.resolve('sent');
      },
      onStatus: () => undefined,
    });

    const first = reporter.setState('travelling');
    const second = reporter.setState('travelling', { background: true });
    const third = reporter.setState('offline');

    // Answer every watch the reporter asks for, in whatever order it asks.
    for (let round = 0; round < 5; round += 1) {
      await settle();
      pending.splice(0).forEach((answer) => {
        answer();
      });
    }
    await Promise.all([first, second, third]);
    await settle();

    expect(open).toBe(0);
    expect(reporter.status().reporting).toBe(false);

    sent.length = 0;
    jest.advanceTimersByTime((LOCATION_BUDGET.travelling?.floorSeconds ?? 0) * 3_000);
    await settle();
    expect(sent).toEqual([]);
  });

  it('keeps working with no surplus at all', async () => {
    const { app, sent, reporter } = await running('working');

    expect(app.watchedWith()?.distanceMeters).toBeNull();
    jest.advanceTimersByTime((LOCATION_BUDGET.working?.floorSeconds ?? 0) * 1_000);
    await settle();

    expect(sent.length).toBeGreaterThan(1);
    await reporter.stop();
  });
});

/**
 * A denial, a rate limit and a killed reporter — the three ways this stops
 * working on a real phone, and what the master is told about each.
 */
describe('the location reporter under refusal', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('degrades rather than breaking when the platform refuses', async () => {
    const app = harness();
    app.denyPermission();
    const { sent, reporter } = reporterFor(app);

    await reporter.setState('online');
    await settle();

    expect(reporter.status().blocked).toBe(true);
    expect(reporter.status().reporting).toBe(false);
    expect(sent).toEqual([]);
  });

  it('backs off after a 429 rather than retrying into the limit', async () => {
    const built = reporterFor(harness());
    const { app, sent } = built;
    built.answerWith('rate-limited');

    await built.reporter.setState('online');
    await settle();
    expect(sent).toHaveLength(1);

    /**
     * Movement inside the backoff window is dropped too — the server counts a
     * surplus report against the same budget the floor spends, so a reporter
     * that only gated the floor would answer a rate limit by reporting
     * *more*.
     *
     * No timer is advanced here on purpose: the online floor is 90 s and the
     * first backoff is 60 s, so advancing one floor would step past the window
     * and the assertion would be about arithmetic rather than about the gate.
     */
    app.move(DOWN_THE_ROAD);
    await settle();

    expect(sent).toHaveLength(1);
    await built.reporter.stop();
  });

  it('resumes once the backoff has passed', async () => {
    const built = reporterFor(harness());
    const { sent } = built;
    built.answerWith('rate-limited');

    await built.reporter.setState('online');
    await settle();
    built.answerWith('sent');

    jest.advanceTimersByTime(RATE_LIMIT_BACKOFF_MS + 1_000);
    await settle();
    jest.advanceTimersByTime((LOCATION_BUDGET.online?.floorSeconds ?? 0) * 1_000);
    await settle();

    expect(sent.length).toBeGreaterThan(1);
    await built.reporter.stop();
  });

  it('tells the master when it has stopped getting through', async () => {
    const built = reporterFor(harness());

    await built.reporter.setState('online');
    await settle();
    built.answerWith('failed');

    const floorMs = (LOCATION_BUDGET.online?.floorSeconds ?? 0) * 1_000;
    for (let beat = 0; beat <= STALE_AFTER_FLOORS + 1; beat += 1) {
      jest.advanceTimersByTime(floorMs);
      await settle();
    }

    expect(built.reporter.status().stale).toBe(true);
    await built.reporter.stop();
  });

  it('stops saying so the moment a report gets through again', async () => {
    const built = reporterFor(harness());

    await built.reporter.setState('online');
    await settle();
    built.answerWith('failed');

    const floorMs = (LOCATION_BUDGET.online?.floorSeconds ?? 0) * 1_000;
    for (let beat = 0; beat <= STALE_AFTER_FLOORS + 1; beat += 1) {
      jest.advanceTimersByTime(floorMs);
      await settle();
    }
    expect(built.reporter.status().stale).toBe(true);

    built.answerWith('sent');
    jest.advanceTimersByTime(floorMs);
    await settle();

    expect(built.reporter.status().stale).toBe(false);
    await built.reporter.stop();
  });
});
