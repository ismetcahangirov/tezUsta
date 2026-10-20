import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { mapRenders } from '../../test/support/react-native-maps-stub';
import { ARRIVAL_COPY } from '../arrival/arrival-copy';
import { COUNTDOWN_TICK_MS } from '../arrival/useArrivalCountdown';
import { MasterTrackingCard } from './MasterTrackingCard';

/**
 * The tracking card over the **real** map adapter and a stand-in vendor
 * module (issue #399): the arrival countdown ticks once a second beside the
 * native map, and those ticks must re-render the countdown row alone.
 */
jest.unmock('./map-surface');
jest.mock('react-native-maps', () =>
  jest.requireActual<object>('../../test/support/react-native-maps-stub'),
);

const HOME = { latitude: 40.377, longitude: 49.892 };
const MASTER = { latitude: 40.4, longitude: 49.8 };
const VIEW = { kind: 'live', position: MASTER } as const;
const ARRIVAL = {
  promisedAt: '2026-10-20T10:12:30.000Z',
  secondsRemaining: 125,
  source: 'route',
} as const;

describe('MasterTrackingCard with an arrival countdown', () => {
  beforeEach(() => {
    mapRenders.count = 0;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts down without re-rendering the map', async () => {
    await render(<MasterTrackingCard view={VIEW} destination={HOME} arrival={ARRIVAL} />);
    await fireEvent(screen.getByTestId('vendor-map'), 'layout');
    const settled = mapRenders.count;

    await act(async () => {
      jest.advanceTimersByTime(COUNTDOWN_TICK_MS * 70);
      await Promise.resolve();
    });

    expect(screen.getByText(ARRIVAL_COPY.customer.underMinute)).toBeOnTheScreen();
    expect(mapRenders.count).toBe(settled);
  });
});
