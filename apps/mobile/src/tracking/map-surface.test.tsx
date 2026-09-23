import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { valueOf } from '../../test/support/fake-map-surface';
import { camera, mapRenders } from '../../test/support/react-native-maps-stub';
import { MapSurface } from './map-surface';
import { MARKER_TICK_MS } from './tracking-policy';

/**
 * The adapter itself, against a stand-in for the vendor module (issue #172).
 *
 * Every other suite replaces `map-surface.tsx` wholesale (`jest.setup.js`).
 * This one keeps it and replaces `react-native-maps` underneath instead, to
 * check the half only this file owns: that each marker reaches the map with
 * its coordinate and its accessible name, that the map is asked for the app's
 * theme, that the camera frames what it is given, and that it is a picture
 * rather than a control.
 */
jest.unmock('./map-surface');
jest.mock('react-native-maps', () =>
  jest.requireActual<object>('../../test/support/react-native-maps-stub'),
);

const HOME = { latitude: 40.377, longitude: 49.892 };
const MASTER = { latitude: 40.4, longitude: 49.8 };

describe('MapSurface', () => {
  beforeEach(() => {
    camera.fitToCoordinates.mockClear();
    camera.animateCamera.mockClear();
    mapRenders.count = 0;
  });

  it('draws both markers where it is told, under their accessible names', async () => {
    await render(
      <MapSurface
        destination={{ point: HOME, label: 'Home' }}
        master={{ point: MASTER, label: 'Master', appearance: 'live' }}
        frame={[HOME, MASTER]}
        scheme="light"
        accessibilityLabel="Map"
      />,
    );

    expect(valueOf(screen.getByLabelText('Home'))).toBe(JSON.stringify(HOME));
    expect(valueOf(screen.getByLabelText('Master'))).toBe(JSON.stringify(MASTER));
  });

  it.each(['light', 'dark'] as const)('asks the platform for its %s map', async (scheme) => {
    await render(
      <MapSurface
        destination={null}
        master={{ point: MASTER, label: 'Master', appearance: 'stale' }}
        frame={[MASTER]}
        scheme={scheme}
        accessibilityLabel="Map"
      />,
    );

    expect(screen.getByTestId('vendor-map').props.userInterfaceStyle).toBe(scheme);
  });

  it('frames the address and the master together once the map is ready', async () => {
    await render(
      <MapSurface
        destination={{ point: HOME, label: 'Home' }}
        master={{ point: MASTER, label: 'Master', appearance: 'live' }}
        frame={[HOME, MASTER]}
        scheme="light"
        accessibilityLabel="Map"
      />,
    );
    expect(camera.fitToCoordinates).not.toHaveBeenCalled();

    await fireEvent(screen.getByTestId('vendor-map'), 'layout');

    expect(camera.fitToCoordinates).toHaveBeenCalledWith(
      [HOME, MASTER],
      expect.objectContaining({ animated: true }),
    );
  });

  it('centres on the master alone when there is no address to frame', async () => {
    await render(
      <MapSurface
        destination={null}
        master={{ point: MASTER, label: 'Master', appearance: 'live' }}
        frame={[MASTER]}
        scheme="light"
        accessibilityLabel="Map"
      />,
    );

    await fireEvent(screen.getByTestId('vendor-map'), 'layout');

    expect(camera.animateCamera).toHaveBeenCalledWith(
      expect.objectContaining({ center: MASTER }),
      expect.anything(),
    );
  });

  /**
   * The glide ticks four times a second on a mid-range Android; a tick must
   * reconcile the master's marker, not the whole map.
   */
  it('moves the master’s marker between reports without re-rendering the map', async () => {
    jest.useFakeTimers();
    try {
      const props = {
        destination: { point: HOME, label: 'Home' },
        frame: [HOME, MASTER],
        scheme: 'light' as const,
        accessibilityLabel: 'Map',
      };
      const { rerender } = await render(
        <MapSurface {...props} master={{ point: MASTER, label: 'Master', appearance: 'live' }} />,
      );
      const NEXT = { latitude: 40.41, longitude: 49.82 };
      await rerender(
        <MapSurface {...props} master={{ point: NEXT, label: 'Master', appearance: 'live' }} />,
      );
      const rendersAfterReport = mapRenders.count;

      await act(async () => {
        jest.advanceTimersByTime(MARKER_TICK_MS * 8);
        await Promise.resolve();
      });

      const drawn = JSON.parse(valueOf(screen.getByLabelText('Master')) ?? 'null') as {
        latitude: number;
      };
      expect(drawn.latitude).toBeGreaterThan(MASTER.latitude);
      expect(drawn.latitude).toBeLessThan(NEXT.latitude);
      expect(mapRenders.count).toBe(rendersAfterReport);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * Inside the order screen's `ScrollView`, a pannable map would take the
   * scroll gesture away from the rest of the order.
   */
  it('is a picture, not a control', async () => {
    await render(
      <MapSurface
        destination={null}
        master={null}
        frame={[]}
        scheme="light"
        accessibilityLabel="Map"
      />,
    );

    const map = screen.getByTestId('vendor-map');
    expect(map.props.scrollEnabled).toBe(false);
    expect(map.props.zoomEnabled).toBe(false);
    expect(map.props.rotateEnabled).toBe(false);
    expect(map.props.pitchEnabled).toBe(false);
  });
});
