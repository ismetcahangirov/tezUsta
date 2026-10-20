import type { OrderSearchProgress } from '@tezusta/types';
import { act, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Platform } from 'react-native';

import { pointText, valueOf } from '../../test/support/fake-map-surface';
import { outstandingTimers } from '../../test/support/pending-timers';
import { SEARCH_RADAR_COPY as copy } from './search-radar-copy';
import type { RadarView } from './search-radar-policy';
import { SearchRadarCard } from './SearchRadarCard';

const HOME = { latitude: 40.377, longitude: 49.892 };
const CELLS = [
  { latitude: 40.3775, longitude: 49.8917 },
  { latitude: 40.3925, longitude: 49.8851 },
];

/** The pulse is decoration hidden from screen readers, so its queries include hidden elements. */
const HIDDEN = { includeHiddenElements: true } as const;

function progress(overrides: Partial<OrderSearchProgress> = {}): OrderSearchProgress {
  return {
    round: 2,
    radiusM: 4_400,
    maxRadiusM: 10_000,
    endsAt: '2026-10-20T10:03:00.000Z',
    offeredCount: 3,
    cells: CELLS,
    ...overrides,
  };
}

function reduceMotion(enabled: boolean): void {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(enabled);
}

/** Renders, then lets the reduce-motion answer land. */
async function show(view: RadarView, centre: typeof HOME | null = HOME): Promise<void> {
  await render(<SearchRadarCard view={view} centre={centre} />);
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * The search radar, one state at a time (issue #398). The map is the
 * boundary fake (`fake-map-surface.tsx`), so every assertion is on what a
 * customer sees and hears: the sentence, the map's label, the markers and
 * whether anything moves.
 */
describe('SearchRadarCard', () => {
  beforeEach(() => {
    reduceMotion(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders nothing while hidden', async () => {
    await show({ kind: 'hidden' });

    expect(screen.queryByText(copy.title)).not.toBeOnTheScreen();
  });

  it('starts with the address and the pulse, and no ring or count yet', async () => {
    await show({ kind: 'loading' });

    expect(screen.getByText(copy.starting)).toBeOnTheScreen();
    expect(valueOf(screen.getByLabelText(copy.addressMarker))).toBe(pointText(HOME));
    expect(screen.queryByTestId('map-ring')).not.toBeOnTheScreen();
    expect(screen.queryAllByLabelText(copy.cellMarker)).toHaveLength(0);
    expect(screen.getByTestId('radar-pulse-running', HIDDEN)).toBeOnTheScreen();
  });

  it('draws the ring, the cells and the count while live', async () => {
    await show({ kind: 'live', progress: progress() });

    expect(screen.getByLabelText(copy.mapLabel)).toBeOnTheScreen();
    expect(valueOf(screen.getByTestId('map-ring'))).toBe(`${pointText(HOME)}@4400`);
    expect(screen.getAllByLabelText(copy.cellMarker).map((cell) => valueOf(cell))).toStrictEqual(
      CELLS.map(pointText),
    );
    expect(screen.getByText(copy.reached(3))).toBeOnTheScreen();
    expect(screen.getByTestId('radar-pulse-running', HIDDEN)).toBeOnTheScreen();
  });

  it('says so when the search has reached nobody yet', async () => {
    await show({ kind: 'live', progress: progress({ offeredCount: 0, cells: [] }) });

    expect(screen.getByText(copy.reachedNobody)).toBeOnTheScreen();
  });

  it('keeps the last picture but stops the pulse while reconnecting', async () => {
    await show({ kind: 'reconnecting', progress: progress() });

    expect(screen.getByText(copy.reconnecting)).toBeOnTheScreen();
    expect(screen.getAllByLabelText(copy.cellMarker)).toHaveLength(2);
    expect(screen.getByTestId('radar-pulse-still', HIDDEN)).toBeOnTheScreen();
  });

  it('says the search continues when the read failed, with no map', async () => {
    await show({ kind: 'error' });

    expect(screen.getByText(copy.error)).toBeOnTheScreen();
    expect(screen.queryByLabelText(copy.mapLabel)).not.toBeOnTheScreen();
  });

  it('is a sentence without a map when the address does not resolve', async () => {
    await show({ kind: 'live', progress: progress() }, null);

    expect(screen.getByText(copy.reached(3))).toBeOnTheScreen();
    expect(screen.queryByLabelText(copy.mapLabel)).not.toBeOnTheScreen();
  });

  it('does not pulse when the system asks for reduced motion', async () => {
    reduceMotion(true);
    await show({ kind: 'live', progress: progress() });

    expect(screen.getByTestId('radar-pulse-still', HIDDEN)).toBeOnTheScreen();
    expect(screen.queryByTestId('radar-pulse-running', HIDDEN)).not.toBeOnTheScreen();
  });

  it('stops pulsing the moment reduce motion is switched on', async () => {
    let changed: ((enabled: boolean) => void) | undefined;
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
      _event: string,
      listener: (enabled: boolean) => void,
    ) => {
      changed = listener;
      return { remove: jest.fn() };
    }) as unknown as typeof AccessibilityInfo.addEventListener);
    await show({ kind: 'live', progress: progress() });
    expect(screen.getByTestId('radar-pulse-running', HIDDEN)).toBeOnTheScreen();

    await act(async () => {
      changed?.(true);
      await Promise.resolve();
    });

    expect(screen.getByTestId('radar-pulse-still', HIDDEN)).toBeOnTheScreen();
  });

  it('announces the count on iOS, where VoiceOver has no live regions', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const original = Platform.OS;
    Platform.OS = 'ios';
    try {
      await show({ kind: 'live', progress: progress({ offeredCount: 5 }) });

      expect(announce).toHaveBeenCalledWith(copy.reached(5));
    } finally {
      Platform.OS = original;
    }
  });

  it('names nobody: every point is labelled alike', async () => {
    await show({ kind: 'live', progress: progress() });

    const labels = new Set(
      screen
        .getAllByLabelText(copy.cellMarker)
        .map((cell) => (cell.props as { accessibilityLabel?: string }).accessibilityLabel),
    );
    expect([...labels]).toStrictEqual([copy.cellMarker]);
  });

  it('leaves no timer running once it unmounts', async () => {
    jest.useFakeTimers();
    try {
      const { unmount } = await render(
        <SearchRadarCard view={{ kind: 'live', progress: progress() }} centre={HOME} />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      await unmount();

      expect(outstandingTimers()).toStrictEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});
