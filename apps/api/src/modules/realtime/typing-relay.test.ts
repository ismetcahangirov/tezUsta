import { describe, expect, it } from 'vitest';

import type { AuthenticatedSocket } from './realtime.types';
import { TYPING_RELAY_INTERVAL_MS, TypingRelay } from './typing-relay';

function socket(id: string): AuthenticatedSocket {
  return { id } as AuthenticatedSocket;
}

const ORDER = '01a0ce98-e0d9-72d5-975c-1f56c7de26ae';
const OTHER_ORDER = '01a0ce98-e0d9-72d5-975c-1f56c7de26af';

describe('TypingRelay', () => {
  it('relays the first frame and drops the rest of its interval', () => {
    const relay = new TypingRelay();
    const client = socket('a');

    expect(relay.admit(client, ORDER, 1_000)).toBe(true);
    expect(relay.admit(client, ORDER, 1_001)).toBe(false);
    expect(relay.admit(client, ORDER, 1_000 + TYPING_RELAY_INTERVAL_MS - 1)).toBe(false);
    expect(relay.admit(client, ORDER, 1_000 + TYPING_RELAY_INTERVAL_MS)).toBe(true);
  });

  it('keeps one interval per socket and per order', () => {
    const relay = new TypingRelay();

    expect(relay.admit(socket('a'), ORDER, 1_000)).toBe(true);
    expect(relay.admit(socket('b'), ORDER, 1_000)).toBe(true);
    expect(relay.admit(socket('a'), OTHER_ORDER, 1_000)).toBe(true);
  });

  it('forgets a socket that disconnected', () => {
    const relay = new TypingRelay();
    const client = socket('a');

    relay.admit(client, ORDER, 1_000);
    relay.release(client);

    expect(relay.admit(client, ORDER, 1_001)).toBe(true);
  });
});
