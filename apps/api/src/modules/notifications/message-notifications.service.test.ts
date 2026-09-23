import { describe, expect, it } from 'vitest';

import { messagePushJobId } from './message-notifications.service';

const CONVERSATION = '01a0ce98-e0d9-72d5-975c-1f56c7de26ae';
const WINDOW_MS = 10_000;

describe('messagePushJobId', () => {
  it('gives every message inside one window the same job, so a burst coalesces', () => {
    const first = messagePushJobId(CONVERSATION, 'master', 100_000, WINDOW_MS);

    expect(messagePushJobId(CONVERSATION, 'master', 100_001, WINDOW_MS)).toBe(first);
    expect(messagePushJobId(CONVERSATION, 'master', 109_999, WINDOW_MS)).toBe(first);
  });

  it('opens a new job in the next window, so a later message is not refused by a retained one', () => {
    expect(messagePushJobId(CONVERSATION, 'master', 110_000, WINDOW_MS)).not.toBe(
      messagePushJobId(CONVERSATION, 'master', 109_999, WINDOW_MS),
    );
  });

  it('keeps the two recipients of one conversation apart', () => {
    expect(messagePushJobId(CONVERSATION, 'customer', 100_000, WINDOW_MS)).not.toBe(
      messagePushJobId(CONVERSATION, 'master', 100_000, WINDOW_MS),
    );
  });

  it('never contains a colon, which BullMQ refuses in a custom id', () => {
    expect(messagePushJobId(CONVERSATION, 'master', 100_000, WINDOW_MS)).not.toContain(':');
  });
});
