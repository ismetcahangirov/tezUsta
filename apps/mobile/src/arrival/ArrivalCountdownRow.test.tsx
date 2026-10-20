import type { ArrivalPromise } from '@tezusta/types';
import { act, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { formatMessageTime } from '../conversation/format-message-time';
import { ARRIVAL_COPY as copy } from './arrival-copy';
import { ArrivalCountdownRow } from './ArrivalCountdownRow';
import { COUNTDOWN_TICK_MS } from './useArrivalCountdown';

let mockMono = 0;
jest.mock('../lib/monotonic-clock', () => ({ monotonicNow: () => mockMono }));

const PROMISED_AT = '2026-10-20T10:12:30.000Z';
/** The clock time both screens print, built through the app's own formatter. */
const CLOCK = formatMessageTime(PROMISED_AT);

function promise(secondsRemaining: number): ArrivalPromise {
  return { promisedAt: PROMISED_AT, secondsRemaining, source: 'estimate' };
}

async function elapse(ms: number): Promise<void> {
  await act(async () => {
    mockMono += ms;
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

function toneOf(text: string): string {
  return String((screen.getByText(text).props as { className?: string }).className);
}

/** The arrival row, as each party sees it (issue #399, ADR-0055 § 12). */
describe('ArrivalCountdownRow', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockMono = 5_000_000;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('the customer', () => {
    it('sees that the time is being calculated before the promise arrives', async () => {
      await render(<ArrivalCountdownRow promise={null} viewer="customer" />);

      expect(screen.getByText(copy.customer.pending)).toBeOnTheScreen();
    });

    it('sees the minutes left and the clock time', async () => {
      await render(<ArrivalCountdownRow promise={promise(420)} viewer="customer" />);

      expect(screen.getByText(copy.customer.minutesLeft(7))).toBeOnTheScreen();
      expect(screen.getByText(copy.customer.arrivingBy(CLOCK))).toBeOnTheScreen();
    });

    it('sees "less than a minute" rather than a zero', async () => {
      await render(<ArrivalCountdownRow promise={promise(42)} viewer="customer" />);

      expect(screen.getByText(copy.customer.underMinute)).toBeOnTheScreen();
    });

    it('sees "running late" in the ordinary tone once it passes', async () => {
      const fixed = promise(5);
      await render(<ArrivalCountdownRow promise={fixed} viewer="customer" />);

      await elapse(COUNTDOWN_TICK_MS * 6);

      expect(screen.getByText(copy.customer.late(1))).toBeOnTheScreen();
      expect(toneOf(copy.customer.late(1))).not.toContain('text-danger');
      expect(screen.getByText(copy.customer.arrivingBy(CLOCK))).toBeOnTheScreen();
    });

    it('never says where the time came from', async () => {
      await render(<ArrivalCountdownRow promise={promise(420)} viewer="customer" />);

      expect(screen.queryByText(/estimate|təxmin/i)).not.toBeOnTheScreen();
    });
  });

  describe('the master', () => {
    it('sees when to be there and how long is left', async () => {
      await render(<ArrivalCountdownRow promise={promise(720)} viewer="master" />);

      expect(screen.getByText(copy.master.minutesLeft(12))).toBeOnTheScreen();
      expect(screen.getByText(copy.master.beThereBy(CLOCK))).toBeOnTheScreen();
    });

    it('sees "you are N min late" in the danger tone', async () => {
      await render(<ArrivalCountdownRow promise={promise(-150)} viewer="master" />);

      expect(screen.getByText(copy.master.late(3))).toBeOnTheScreen();
      expect(toneOf(copy.master.late(3))).toContain('text-danger');
    });
  });

  it('announces the change to late once, naming no number, not on every tick', async () => {
    // RN's jest preset already makes this a `jest.fn`, so `spyOn` hands back
    // the shared mock with earlier tests' calls on it.
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    const fixed = promise(3);
    await render(<ArrivalCountdownRow promise={fixed} viewer="master" />);
    expect(announce).not.toHaveBeenCalled();

    await elapse(COUNTDOWN_TICK_MS * 4);
    await elapse(COUNTDOWN_TICK_MS * 90);

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(copy.master.lateAnnouncement);
  });

  it('does not announce a promise that was already late when the screen opened', async () => {
    // RN's jest preset already makes this a `jest.fn`, so `spyOn` hands back
    // the shared mock with earlier tests' calls on it.
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    await render(<ArrivalCountdownRow promise={promise(-60)} viewer="customer" />);

    await elapse(COUNTDOWN_TICK_MS * 5);

    expect(announce).not.toHaveBeenCalled();
  });
});
