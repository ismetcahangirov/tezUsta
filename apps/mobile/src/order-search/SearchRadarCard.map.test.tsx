import type { OrderSearchProgress } from '@tezusta/types';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { camera, mapRenders } from '../../test/support/react-native-maps-stub';
import { PULSE_MS } from './RadarPulse';
import { SearchRadarCard } from './SearchRadarCard';

/**
 * The radar over the **real** map adapter and a stand-in vendor module, to
 * prove the one performance claim the card makes (issue #398, ADR-0055 § 2):
 * the pulse runs without re-rendering the native map, and a wave re-renders it
 * only when what it draws changed. The order screen's `ScrollView` on a
 * mid-range Android is where a map re-rendered per frame would show.
 */
jest.unmock('../tracking/map-surface');
jest.mock('react-native-maps', () =>
  jest.requireActual<object>('../../test/support/react-native-maps-stub'),
);

const HOME = { latitude: 40.377, longitude: 49.892 };
const CELLS = [{ latitude: 40.3775, longitude: 49.8917 }];

function progress(radiusM: number, cells = CELLS): OrderSearchProgress {
  return {
    round: 2,
    radiusM,
    maxRadiusM: 10_000,
    endsAt: '2026-10-20T10:03:00.000Z',
    offeredCount: 3,
    cells,
  };
}

describe('SearchRadarCard over the real map adapter', () => {
  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    camera.fitToCoordinates.mockClear();
    mapRenders.count = 0;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('pulses without re-rendering the map, and re-renders it once per changed wave', async () => {
    const first = progress(4_400);
    const { rerender } = await render(
      <SearchRadarCard view={{ kind: 'live', progress: first }} centre={HOME} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await fireEvent(screen.getByTestId('vendor-map'), 'layout');
    const settled = mapRenders.count;

    // Several pulse cycles.
    await act(async () => {
      jest.advanceTimersByTime(PULSE_MS * 4);
      await Promise.resolve();
    });
    expect(mapRenders.count).toBe(settled);

    // A wave that changed nothing the map draws: the same radius, and the same
    // cells object, as RTK Query's structural sharing hands back.
    await rerender(
      <SearchRadarCard
        view={{ kind: 'live', progress: { ...first, round: 3, offeredCount: 4 } }}
        centre={HOME}
      />,
    );
    expect(mapRenders.count).toBe(settled);

    // A wave that widened the ring: one render, and the camera fits the ring.
    camera.fitToCoordinates.mockClear();
    await rerender(
      <SearchRadarCard view={{ kind: 'live', progress: progress(5_800) }} centre={HOME} />,
    );
    expect(mapRenders.count).toBe(settled + 1);
    expect(camera.fitToCoordinates).toHaveBeenCalledTimes(1);
    const [framed] = camera.fitToCoordinates.mock.calls[0] as [
      { latitude: number; longitude: number }[],
    ];
    expect(framed).toHaveLength(4);
    expect(Math.max(...framed.map((point) => point.latitude))).toBeCloseTo(
      HOME.latitude + 5_800 / 111_320,
      6,
    );
  });
});
