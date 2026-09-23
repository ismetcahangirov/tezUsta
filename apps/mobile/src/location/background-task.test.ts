import * as Location from 'expo-location';
import type { LocationObject } from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import {
  BACKGROUND_LOCATION_TASK,
  handleBackgroundLocations,
  newestOf,
  setBackgroundListener,
} from './background-task';
import type { Position } from './location-port';

jest.mock('expo-task-manager', () => ({ defineTask: jest.fn() }));
jest.mock('expo-location', () => ({ stopLocationUpdatesAsync: jest.fn(() => Promise.resolve()) }));

function at(timestamp: number, latitude: number): LocationObject {
  return {
    timestamp,
    coords: {
      latitude,
      longitude: 49.89,
      altitude: null,
      accuracy: 10,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
  };
}

const EXECUTION = { eventId: 'e', taskName: BACKGROUND_LOCATION_TASK };

afterEach(() => {
  setBackgroundListener(null);
});

describe('the background location task (issue #171)', () => {
  it('is defined at module scope, so a relaunch in the background finds it', () => {
    expect(TaskManager.defineTask).toHaveBeenCalledWith(
      BACKGROUND_LOCATION_TASK,
      handleBackgroundLocations,
    );
  });

  it('collapses a deferred batch into its newest point — one report, not several', async () => {
    const received: Position[] = [];
    setBackgroundListener((position) => received.push(position));

    await handleBackgroundLocations({
      data: { locations: [at(3_000, 40.3), at(9_000, 40.9), at(6_000, 40.6)] },
      error: null,
      executionInfo: EXECUTION,
    });

    expect(received).toEqual([{ latitude: 40.9, longitude: 49.89 }]);
  });

  it('ends an orphaned session — one nobody is listening to — instead of sending on its own', async () => {
    const received: Position[] = [];

    await handleBackgroundLocations({
      data: { locations: [at(1_000, 40.1)] },
      error: null,
      executionInfo: EXECUTION,
    });

    setBackgroundListener((position) => received.push(position));
    expect(received).toEqual([]);
    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK);
  });

  it('leaves a session alone while a reporter is listening to it', async () => {
    jest.mocked(Location.stopLocationUpdatesAsync).mockClear();
    setBackgroundListener(jest.fn());

    await handleBackgroundLocations({
      data: { locations: [at(1_000, 40.1)] },
      error: null,
      executionInfo: EXECUTION,
    });

    expect(Location.stopLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('delivers nothing for a failed task', async () => {
    const listener = jest.fn();
    setBackgroundListener(listener);

    await handleBackgroundLocations({
      data: { locations: [at(1_000, 40.1)] },
      error: { code: 1, message: 'location unavailable' },
      executionInfo: EXECUTION,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it('has no newest point in an empty batch', () => {
    expect(newestOf([])).toBeNull();
  });
});
