import type { CursorPage, Message } from '@tezusta/types';

import { mergePages, placeMessage, stampRead } from './message-history';

function message(id: string, createdAt: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: 'conversation-1',
    senderKind: 'master',
    body: id,
    createdAt,
    readAt: null,
    ...overrides,
  };
}

function history(...pages: Message[][]): { pages: CursorPage<Message>[] } {
  return { pages: pages.map((items) => ({ items, nextCursor: null })) };
}

function ids(value: { pages: readonly CursorPage<Message>[] }): string[] {
  return mergePages(value.pages).map((item) => item.id);
}

/**
 * The rules the conversation's cache is kept by (issue #182). The screen tests
 * cover the same rules end to end; these pin the orderings that are awkward to
 * provoke through a socket.
 */
describe('message history', () => {
  it('shows each message once however the pages overlap', () => {
    const shared = message('m-2', '2026-09-23T08:02:00.000Z');

    expect(ids(history([message('m-3', '2026-09-23T08:03:00.000Z'), shared], [shared]))).toEqual([
      'm-3',
      'm-2',
    ]);
  });

  it('places a message by when it was written, not when it arrived', () => {
    const loaded = history([
      message('m-3', '2026-09-23T08:03:00.000Z'),
      message('m-1', '2026-09-23T08:01:00.000Z'),
    ]);

    const placed = placeMessage(loaded, message('m-2', '2026-09-23T08:02:00.000Z'));

    expect(placed.added).toBe(true);
    expect(ids(placed.history)).toEqual(['m-3', 'm-2', 'm-1']);
  });

  it('replaces a message it already holds instead of adding it twice', () => {
    const loaded = history([message('m-1', '2026-09-23T08:01:00.000Z')]);

    const placed = placeMessage(
      loaded,
      message('m-1', '2026-09-23T08:01:00.000Z', { body: 'yenilənmiş' }),
    );

    expect(placed.added).toBe(false);
    expect(mergePages(placed.history.pages)).toEqual([
      message('m-1', '2026-09-23T08:01:00.000Z', { body: 'yenilənmiş' }),
    ]);
  });

  it('stamps read the reader’s counterpart’s messages up to the named one only', () => {
    const loaded = history([
      message('m-4', '2026-09-23T08:04:00.000Z', { senderKind: 'customer' }),
      message('m-3', '2026-09-23T08:03:00.000Z', { senderKind: 'master' }),
      message('m-2', '2026-09-23T08:02:00.000Z', { senderKind: 'customer' }),
      message('m-1', '2026-09-23T08:01:00.000Z', {
        senderKind: 'customer',
        readAt: '2026-09-23T08:01:30.000Z',
      }),
    ]);

    const stamped = stampRead(loaded, 'master', 'm-2', '2026-09-23T08:05:00.000Z');

    const readAt = new Map(mergePages(stamped?.pages ?? []).map((item) => [item.id, item.readAt]));
    expect(readAt.get('m-4')).toBeNull();
    // The reader's own message is never stamped by their own receipt.
    expect(readAt.get('m-3')).toBeNull();
    expect(readAt.get('m-2')).toBe('2026-09-23T08:05:00.000Z');
    // An earlier stamp is kept.
    expect(readAt.get('m-1')).toBe('2026-09-23T08:01:30.000Z');
  });

  it('declines to guess when the named message is not loaded', () => {
    const loaded = history([
      message('m-1', '2026-09-23T08:01:00.000Z', { senderKind: 'customer' }),
    ]);

    expect(stampRead(loaded, 'master', 'm-unknown', '2026-09-23T08:05:00.000Z')).toBeNull();
  });
});
