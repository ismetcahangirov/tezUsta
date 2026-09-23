import { act, render, screen } from '@testing-library/react-native';
import { colorScheme } from 'nativewind';
import { AccessibilityInfo, Platform } from 'react-native';

import { pointText, valueOf } from '../../test/support/fake-map-surface';
import { outstandingTimers } from '../../test/support/pending-timers';
import { MasterTrackingCard } from './MasterTrackingCard';
import { TRACKING_COPY as copy } from './tracking-copy';
import { MARKER_GLIDE_MS, MARKER_TICK_MS, type TrackingView } from './tracking-policy';

const HOME = { latitude: 40.377, longitude: 49.892 };
const FIRST = { latitude: 40.4, longitude: 49.8 };
const SECOND = { latitude: 40.41, longitude: 49.82 };

function masterMarker(label: string = copy.masterMarker) {
  return screen.getByLabelText(label);
}

function drawnAt(label?: string): string | undefined {
  return valueOf(masterMarker(label));
}

/**
 * The tracking card, one state at a time (issue #172).
 *
 * The map itself is replaced at its boundary (`test/support/fake-map-surface.tsx`,
 * installed for the whole suite by `jest.setup.js`), so every assertion is on
 * what a customer would perceive: which sentence is on screen, which markers
 * the map draws, and where.
 */
describe('MasterTrackingCard', () => {
  it('renders nothing while the order is not being tracked', async () => {
    await render(<MasterTrackingCard view={{ kind: 'hidden' }} destination={HOME} />);

    expect(screen.queryByText(copy.title)).not.toBeOnTheScreen();
    expect(screen.queryByLabelText(copy.mapLabel)).not.toBeOnTheScreen();
  });

  it('says plainly that there is no position, and draws no map', async () => {
    await render(<MasterTrackingCard view={{ kind: 'absent' }} destination={HOME} />);

    expect(screen.getByText(copy.absentTitle)).toBeOnTheScreen();
    expect(screen.getByText(copy.absentDescription)).toBeOnTheScreen();
    expect(screen.queryByLabelText(copy.mapLabel)).not.toBeOnTheScreen();
  });

  it('draws the master and the customer’s address on a live map', async () => {
    await render(
      <MasterTrackingCard view={{ kind: 'live', position: FIRST }} destination={HOME} />,
    );

    expect(screen.getByLabelText(copy.mapLabel)).toBeOnTheScreen();
    expect(drawnAt()).toBe(pointText(FIRST));
    expect(valueOf(screen.getByLabelText(copy.destinationMarker))).toBe(pointText(HOME));
    expect(screen.getByText(copy.live)).toBeOnTheScreen();
  });

  it('frames the master alone when the address does not resolve', async () => {
    await render(
      <MasterTrackingCard view={{ kind: 'live', position: FIRST }} destination={null} />,
    );

    expect(drawnAt()).toBe(pointText(FIRST));
    expect(screen.queryByLabelText(copy.destinationMarker)).not.toBeOnTheScreen();
  });

  it('labels a stale point as stale and never as live', async () => {
    await render(
      <MasterTrackingCard view={{ kind: 'stale', position: FIRST }} destination={HOME} />,
    );

    expect(screen.getByText(copy.stale)).toBeOnTheScreen();
    expect(screen.getByLabelText(copy.masterMarkerStale)).toBeOnTheScreen();
    expect(screen.queryByLabelText(copy.masterMarker)).not.toBeOnTheScreen();
    expect(screen.queryByText(copy.live)).not.toBeOnTheScreen();
  });

  it('says it is reconnecting, drawing the last point as not live', async () => {
    await render(
      <MasterTrackingCard view={{ kind: 'reconnecting', position: FIRST }} destination={HOME} />,
    );

    expect(screen.getByText(copy.reconnecting)).toBeOnTheScreen();
    expect(screen.getByLabelText(copy.masterMarkerStale)).toBeOnTheScreen();
    expect(screen.queryByText(copy.live)).not.toBeOnTheScreen();
  });

  it('says it is reconnecting when there was never a point', async () => {
    await render(
      <MasterTrackingCard view={{ kind: 'reconnecting', position: null }} destination={HOME} />,
    );

    expect(screen.getByText(copy.reconnecting)).toBeOnTheScreen();
    expect(screen.queryByLabelText(copy.mapLabel)).not.toBeOnTheScreen();
  });

  /**
   * VoiceOver has no live regions, so on iOS a change of state is announced
   * explicitly (Android's TalkBack reads the polite live region instead).
   */
  it('announces a change of state to VoiceOver', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const os = Platform.OS;
    Platform.OS = 'ios';
    try {
      const { rerender } = await render(
        <MasterTrackingCard view={{ kind: 'live', position: FIRST }} destination={HOME} />,
      );
      await rerender(
        <MasterTrackingCard view={{ kind: 'stale', position: FIRST }} destination={HOME} />,
      );

      expect(announce).toHaveBeenCalledWith(copy.live);
      expect(announce).toHaveBeenLastCalledWith(copy.stale);
    } finally {
      Platform.OS = os;
      announce.mockRestore();
    }
  });

  describe('in each theme', () => {
    // After every test's own teardown has unmounted it, so the change of
    // scheme lands on nothing rather than on a mounted tree outside `act`.
    afterAll(() => {
      colorScheme.set('light');
    });

    it.each(['light', 'dark'] as const)('asks for the %s map', async (scheme) => {
      colorScheme.set(scheme);

      await render(
        <MasterTrackingCard view={{ kind: 'live', position: FIRST }} destination={HOME} />,
      );

      expect(valueOf(screen.getByLabelText(copy.mapLabel))).toBe(scheme);
      expect(screen.getByText(copy.live)).toBeOnTheScreen();
    });
  });

  describe('as reports arrive', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    async function renderLive(position: typeof FIRST) {
      return render(<MasterTrackingCard view={{ kind: 'live', position }} destination={HOME} />);
    }

    it('glides the marker towards a new live point instead of jumping', async () => {
      const { rerender } = await renderLive(FIRST);

      await rerender(
        <MasterTrackingCard view={{ kind: 'live', position: SECOND }} destination={HOME} />,
      );
      // Nothing has moved until the first tick.
      expect(drawnAt()).toBe(pointText(FIRST));

      await act(async () => {
        jest.advanceTimersByTime(MARKER_GLIDE_MS / 2);
        await Promise.resolve();
      });
      const halfway = {
        latitude: (FIRST.latitude + SECOND.latitude) / 2,
        longitude: (FIRST.longitude + SECOND.longitude) / 2,
      };
      expect(drawnAt()).toBe(pointText(halfway));

      await act(async () => {
        jest.advanceTimersByTime(MARKER_GLIDE_MS / 2 + MARKER_TICK_MS);
        await Promise.resolve();
      });
      expect(drawnAt()).toBe(pointText(SECOND));
    });

    it('does not animate towards a point that arrives while stale', async () => {
      const { rerender } = await render(
        <MasterTrackingCard view={{ kind: 'stale', position: FIRST }} destination={HOME} />,
      );

      // The first live point after a stale spell is placed, not glided to:
      // the path between them is one the screen cannot vouch for.
      await rerender(
        <MasterTrackingCard view={{ kind: 'live', position: SECOND }} destination={HOME} />,
      );

      expect(drawnAt()).toBe(pointText(SECOND));
    });

    it('stops a glide on the reported point the moment the point stops being live', async () => {
      const { rerender } = await renderLive(FIRST);
      await rerender(
        <MasterTrackingCard view={{ kind: 'live', position: SECOND }} destination={HOME} />,
      );
      await act(async () => {
        jest.advanceTimersByTime(MARKER_TICK_MS * 4);
        await Promise.resolve();
      });

      await rerender(
        <MasterTrackingCard view={{ kind: 'reconnecting', position: SECOND }} destination={HOME} />,
      );
      expect(drawnAt(copy.masterMarkerStale)).toBe(pointText(SECOND));

      await act(async () => {
        jest.advanceTimersByTime(MARKER_GLIDE_MS);
        await Promise.resolve();
      });
      expect(drawnAt(copy.masterMarkerStale)).toBe(pointText(SECOND));
    });
  });

  /**
   * "Unmount cleanly": a glide in progress when the screen is popped must not
   * leave its interval running on a device that cannot spare it.
   */
  it('leaves no timer behind when it unmounts mid-glide', async () => {
    const view = (position: typeof FIRST): TrackingView => ({ kind: 'live', position });
    const { rerender, unmount } = await render(
      <MasterTrackingCard view={view(FIRST)} destination={HOME} />,
    );
    await rerender(<MasterTrackingCard view={view(SECOND)} destination={HOME} />);

    expect(outstandingTimers()).toContainEqual({ kind: 'interval', delayMs: MARKER_TICK_MS });

    await unmount();

    expect(outstandingTimers()).not.toContainEqual({ kind: 'interval', delayMs: MARKER_TICK_MS });
  });
});
