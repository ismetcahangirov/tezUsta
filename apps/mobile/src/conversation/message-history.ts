import type { CursorPage, Message, MessageSenderKind } from '@tezusta/types';

/**
 * The pure half of the conversation's cache handling (issue #182): how pages
 * of history are merged, how a message is placed into them, and how a read
 * receipt is applied. Kept free of Redux so the rules are stated once and
 * read the same from the endpoint file, the socket, and the screen.
 */

/**
 * The pages an infinite query holds — newest page first, each page newest
 * first. Generic so `pageParams` and whatever else the cache entry carries
 * pass through untouched.
 */
export interface MessagePages {
  readonly pages: readonly CursorPage<Message>[];
}

/**
 * Whether `a` was written after `b`.
 *
 * The server's order is `(created_at, id)` descending (`message-cursor.ts`),
 * and both halves compare as strings: `createdAt` is `toISOString()` output,
 * fixed-width UTC, and ids are UUIDv7, which sort by creation time.
 */
export function isNewer(a: Message, b: Message): boolean {
  return a.createdAt === b.createdAt ? a.id > b.id : a.createdAt > b.createdAt;
}

/**
 * Every loaded message, newest first, **each id once**.
 *
 * Duplicates are not supposed to happen — the cursor is keyset, so a page
 * boundary cannot repeat a row — but two writers do touch this cache: a socket
 * frame and a refetch can each deliver the same message, and a send's response
 * can land in a page that a concurrent refetch then also returns. Rendering a
 * message twice is the failure a user notices first, so the merge refuses to,
 * whatever the pages say.
 */
export function mergePages(pages: readonly CursorPage<Message>[]): Message[] {
  const seen = new Set<string>();
  const merged: Message[] = [];

  for (const page of pages) {
    for (const message of page.items) {
      if (!seen.has(message.id)) {
        seen.add(message.id);
        merged.push(message);
      }
    }
  }

  return merged;
}

/**
 * Puts one message where it belongs in the loaded history, or replaces the
 * copy already there. Returns the new history and whether the message was new
 * to it, so a caller that counts arrivals — the unread badge — does not count
 * a repeat.
 *
 * **Placed by time, not prepended.** A frame from the other party can arrive
 * while this user's own send is in flight, and the send's response then lands
 * after it with an *earlier* server timestamp; putting both at the top would
 * show them in arrival order, which is not the order they were written in.
 *
 * Written as a function returning a replacement rather than a recipe mutating
 * a draft: the pages are `readonly` in `packages/types`, and a cast that
 * stripped it to make in-place writes compile would drop the contract's own
 * statement — the same reasoning `apply-realtime-event.ts` gives for orders.
 */
export function placeMessage<T extends MessagePages>(
  history: T,
  message: Message,
): { readonly history: T; readonly added: boolean } {
  const present = history.pages.some((page) =>
    page.items.some((candidate) => candidate.id === message.id),
  );

  if (present) {
    return {
      added: false,
      history: {
        ...history,
        pages: history.pages.map((page) => ({
          ...page,
          items: page.items.map((candidate) => (candidate.id === message.id ? message : candidate)),
        })),
      },
    };
  }

  const [first, ...rest] = history.pages;
  if (first === undefined) {
    // Nothing loaded yet: the first read will bring it.
    return { added: true, history };
  }

  const at = first.items.findIndex((candidate) => isNewer(message, candidate));
  const items =
    at === -1
      ? [...first.items, message]
      : [...first.items.slice(0, at), message, ...first.items.slice(at)];

  return { added: true, history: { ...history, pages: [{ ...first, items }, ...rest] } };
}

/**
 * Stamps `readAt` on the messages the reader has now read: every message the
 * *other* side wrote — which is this client's own, from where the reader
 * stands — at or before `throughMessageId`.
 *
 * The same bound the server applied (`message:read` in
 * `packages/types/src/realtime-event.ts`), so the two cannot disagree about
 * which bubbles are read. A message already stamped keeps its earlier time.
 *
 * Returns `null` when the named message is not in the loaded history — the
 * caller then re-reads rather than guessing which messages the bound covers.
 */
export function stampRead<T extends MessagePages>(
  history: T,
  readerKind: MessageSenderKind,
  throughMessageId: string,
  readAt: string,
): T | null {
  const through = history.pages
    .flatMap((page) => page.items)
    .find((message) => message.id === throughMessageId);

  if (through === undefined) {
    return null;
  }

  return {
    ...history,
    pages: history.pages.map((page) => ({
      ...page,
      items: page.items.map((message) =>
        message.senderKind !== readerKind && message.readAt === null && !isNewer(message, through)
          ? { ...message, readAt }
          : message,
      ),
    })),
  };
}
