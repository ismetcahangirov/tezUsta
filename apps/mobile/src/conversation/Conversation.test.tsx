import type {
  Conversation as ConversationContract,
  CursorPage,
  Message,
  MessageNewRealtimeEvent,
  MessageReadRealtimeEvent,
} from '@tezusta/types';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { actAndSettle } from '../../test/support/act-and-settle';
import { createFakeSocketFactory } from '../../test/support/fake-socket';
import type { FakeSocketFactory } from '../../test/support/fake-socket';
import { createRealtimeConnection } from '../realtime/realtime-connection';
import {
  CONVERSATION_TYPING_EVENT,
  MESSAGE_NEW_EVENT,
  MESSAGE_READ_EVENT,
} from '../realtime/realtime-events';
import { RealtimeProvider } from '../realtime/RealtimeProvider';
import { signedIn } from '../store/session-slice';
import { createTestStore } from '../../test/support/test-store';
import { Conversation } from './Conversation';
import { CONVERSATION_COPY as copy } from './conversation-copy';
import { formatMessageTime } from './format-message-time';
import { READ_RECEIPT_DELAY_MS } from './useReadReceipts';
import { TYPING_LAPSE_MS } from './useTyping';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const ORDER_ID = 'order-1';
const CONVERSATION_ID = 'conversation-1';

function conversation(overrides: Partial<ConversationContract> = {}): ConversationContract {
  return {
    id: CONVERSATION_ID,
    orderId: ORDER_ID,
    unreadCount: 0,
    writable: true,
    createdAt: '2026-09-23T08:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: CONVERSATION_ID,
    senderKind: 'master',
    body: `Mesaj ${id}`,
    createdAt: '2026-09-23T08:10:00.000Z',
    readAt: null,
    ...overrides,
  };
}

function page(items: Message[], nextCursor: string | null = null): CursorPage<Message> {
  return { items, nextCursor };
}

type Reply =
  { readonly status?: number; readonly body?: unknown } | { readonly transportError: true };

/**
 * Keyed by `METHOD path` (and `?cursor=` for an older history page). A list is
 * answered in order and then repeats its last entry.
 */
let replies: Record<string, Reply | Reply[]> = {};
let sent: { method: string; path: string; search: string; body: unknown }[] = [];

function installTransport(): void {
  global.fetch = (async (input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    const url = new URL(request.url);
    const text = typeof init?.body === 'string' ? init.body : await request.clone().text();
    sent.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      body: text === '' ? null : (JSON.parse(text) as unknown),
    });

    const cursor = url.searchParams.get('cursor');
    const key = `${request.method} ${url.pathname}${cursor === null ? '' : `?cursor=${cursor}`}`;
    const configured = replies[key];
    let reply: Reply;
    if (Array.isArray(configured)) {
      reply = configured.length > 1 ? (configured.shift() as Reply) : (configured[0] ?? {});
    } else {
      reply = configured ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: '' } } };
    }

    if ('transportError' in reply) {
      return Promise.reject(new TypeError('Network request failed'));
    }
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function requests(method: string, path: string): typeof sent {
  return sent.filter((call) => call.method === method && call.path === path);
}

const MESSAGES = `/orders/${ORDER_ID}/messages`;
const READ = `/orders/${ORDER_ID}/messages/read`;

/**
 * The factory the last `mount()` built. Module-level so a test body can reach
 * the socket without threading it through every helper.
 */
let currentSockets: FakeSocketFactory | undefined;
function sockets(): FakeSocketFactory {
  if (currentSockets === undefined) {
    throw new Error('mount() first');
  }
  return currentSockets;
}

interface Mounted {
  readonly sockets: FakeSocketFactory;
  readonly onBack: jest.Mock;
}

/**
 * The conversation screen under the app's real connection and store, with a
 * fake socket and a fake HTTP transport under them — the harness
 * `order-live-updates.test.tsx` uses, so every frame below goes through the
 * production re-join, event routing and cache patching.
 */
async function mount(viewer: 'customer' | 'master' = 'customer'): Promise<Mounted> {
  installTransport();
  const sockets = createFakeSocketFactory();
  currentSockets = sockets;
  const store = createTestStore();
  store.dispatch(signedIn({ userId: 'user-1', roles: [viewer] }));
  const onBack = jest.fn();

  await render(
    <Provider store={store}>
      <RealtimeProvider
        createConnection={(options) =>
          createRealtimeConnection({ ...options, createSocket: sockets.factory })
        }
      >
        <Conversation orderId={ORDER_ID} viewer={viewer} onBack={onBack} />
      </RealtimeProvider>
    </Provider>,
  );
  await actAndSettle(() => {
    sockets.latest().serverConnect();
  });

  return { sockets, onBack };
}

async function publish(sockets: FakeSocketFactory, event: string, payload: unknown) {
  await actAndSettle(() => {
    sockets.latest().serverEmit(event, payload);
  });
}

/** What the list reports when rows scroll into view — React Native's own viewability contract. */
async function comeIntoView(messages: readonly Message[]): Promise<void> {
  await act(async () => {
    await fireEvent(screen.getByTestId('conversation-messages'), 'viewableItemsChanged', {
      viewableItems: messages.map((item, index) => ({
        item: { kind: 'message', key: item.id, message: item },
        key: item.id,
        index,
        isViewable: true,
      })),
      changed: [],
    });
    await Promise.resolve();
  });
}

async function type(text: string): Promise<void> {
  await act(async () => {
    await fireEvent.changeText(screen.getByLabelText(copy.composerLabel), text);
    await Promise.resolve();
  });
}

async function pressSend(): Promise<void> {
  await act(async () => {
    await fireEvent.press(screen.getByRole('button', { name: copy.send }));
    await Promise.resolve();
  });
}

/** One animation frame and some — see `order-tracking.test.tsx` on RTK's batched notifications. */
const ANIMATION_FRAME_MS = 20;

/** Moves the fake clock, and lets React run whatever that released. */
async function elapse(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

function mine(time: string, state: string): string {
  return `${time} · ${state}`;
}

beforeEach(() => {
  sent = [];
  replies = {
    [`GET /orders/${ORDER_ID}/conversation`]: { body: conversation() },
    [`GET ${MESSAGES}`]: { body: page([]) },
    [`POST ${READ}`]: { body: conversation() },
  };
});

afterEach(() => {
  jest.useRealTimers();
});

/**
 * The conversation on an active order (issue #182, ADR-0033, ADR-0037).
 *
 * **Asserted on the screen**, the way `order-live-updates.test.tsx` asserts a
 * transition: a test that read the cache would pass with a patch nothing
 * renders (CLAUDE.md §13).
 */
describe('the conversation screen', () => {
  it('shows the history with each side on its own side and the read state of mine', async () => {
    replies[`GET ${MESSAGES}`] = {
      body: page([
        message('m-2', { body: 'Yoldayam.' }),
        message('m-1', {
          senderKind: 'customer',
          body: 'Giriş arxa tərəfdədir.',
          readAt: '2026-09-23T08:09:00.000Z',
          createdAt: '2026-09-23T08:05:00.000Z',
        }),
      ]),
    };
    await mount();

    expect(await screen.findByText('Yoldayam.')).toBeOnTheScreen();
    expect(screen.getByText('Giriş arxa tərəfdədir.')).toBeOnTheScreen();
    expect(
      screen.getByText(mine(formatMessageTime('2026-09-23T08:05:00.000Z'), copy.delivery.read)),
    ).toBeOnTheScreen();
  });

  it('says so when the conversation is empty, and offers the composer', async () => {
    await mount();

    expect(await screen.findByText(copy.emptyTitle)).toBeOnTheScreen();
    expect(screen.getByLabelText(copy.composerLabel)).toBeOnTheScreen();
  });

  it('says there is no conversation on an order that has none', async () => {
    replies[`GET /orders/${ORDER_ID}/conversation`] = {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: '' } },
    };
    await mount();

    expect(await screen.findByText(copy.noneTitle)).toBeOnTheScreen();
    expect(screen.queryByLabelText(copy.composerLabel)).toBeNull();
  });

  describe('sending', () => {
    it('shows a sent message at once and settles it to the server’s identity', async () => {
      const stored = message('m-9', {
        senderKind: 'customer',
        body: 'Zəngi basın.',
        createdAt: '2026-09-23T06:45:00.000Z',
      });
      let answer: (value: Response) => void = () => undefined;
      await mount();
      await screen.findByText(copy.emptyTitle);

      // Hold the POST open so the in-between state can be seen.
      const transport = global.fetch;
      global.fetch = ((input: Request | string, init?: RequestInit) => {
        const request = typeof input === 'string' ? new Request(input, init) : input;
        if (request.method === 'POST' && new URL(request.url).pathname === MESSAGES) {
          sent.push({ method: 'POST', path: MESSAGES, search: '', body: null });
          return new Promise<Response>((resolve) => {
            answer = resolve;
          });
        }
        return transport(input, init);
      }) as typeof fetch;

      await type('  Zəngi basın.  ');
      await pressSend();

      // Immediately, before the server has answered.
      expect(screen.getByText('Zəngi basın.')).toBeOnTheScreen();
      expect(screen.getByText(new RegExp(copy.delivery.sending))).toBeOnTheScreen();
      expect(screen.getByLabelText(copy.composerLabel)).toHaveDisplayValue('');

      await act(async () => {
        answer(
          new Response(JSON.stringify(stored), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
        await Promise.resolve();
      });

      // The server's timestamp, not the phone's, and exactly one bubble.
      expect(
        await screen.findByText(mine(formatMessageTime(stored.createdAt), copy.delivery.sent)),
      ).toBeOnTheScreen();
      expect(screen.getAllByText('Zəngi basın.')).toHaveLength(1);
      expect(screen.queryByText(new RegExp(copy.delivery.sending))).toBeNull();
    });

    it('sends the trimmed text', async () => {
      replies[`POST ${MESSAGES}`] = {
        status: 201,
        body: message('m-9', { senderKind: 'customer', body: 'Salam' }),
      };
      await mount();
      await screen.findByText(copy.emptyTitle);

      await type('  Salam  ');
      await pressSend();

      await waitFor(() => {
        expect(requests('POST', MESSAGES).map((call) => call.body)).toEqual([{ body: 'Salam' }]);
      });
    });

    it('does not offer to send nothing', async () => {
      await mount();
      await screen.findByText(copy.emptyTitle);

      await type('   ');

      expect(screen.getByRole('button', { name: copy.send })).toBeDisabled();
    });

    it('shows a failed send as failed and sends it again on retry', async () => {
      const stored = message('m-9', {
        senderKind: 'customer',
        body: 'Qapı açıqdır.',
        createdAt: '2026-09-23T06:50:00.000Z',
      });
      replies[`POST ${MESSAGES}`] = [{ transportError: true }, { status: 201, body: stored }];
      await mount();
      await screen.findByText(copy.emptyTitle);

      await type('Qapı açıqdır.');
      await pressSend();

      expect(await screen.findByText(copy.delivery.failed)).toBeOnTheScreen();
      // Still on screen with its text — never silently dropped.
      expect(screen.getByText('Qapı açıqdır.')).toBeOnTheScreen();

      await act(async () => {
        await fireEvent.press(screen.getByRole('button', { name: copy.resend }));
        await Promise.resolve();
      });

      expect(
        await screen.findByText(mine(formatMessageTime(stored.createdAt), copy.delivery.sent)),
      ).toBeOnTheScreen();
      expect(screen.queryByText(copy.delivery.failed)).toBeNull();
      expect(screen.getAllByText('Qapı açıqdır.')).toHaveLength(1);
      expect(requests('POST', MESSAGES)).toHaveLength(2);
    });

    it('takes the composer away when the order ended while the user was typing', async () => {
      replies[`GET /orders/${ORDER_ID}/conversation`] = [
        { body: conversation() },
        { body: conversation({ writable: false }) },
      ];
      replies[`POST ${MESSAGES}`] = {
        status: 409,
        body: { error: { code: 'CONVERSATION_NOT_WRITABLE', message: '' } },
      };
      await mount();
      await screen.findByText(copy.emptyTitle);

      await type('Gəlirəm.');
      await pressSend();

      expect(await screen.findByText(copy.closedNotice)).toBeOnTheScreen();
      expect(screen.queryByLabelText(copy.composerLabel)).toBeNull();
      // The message the server refused is still there, marked as not sent.
      expect(screen.getByText('Gəlirəm.')).toBeOnTheScreen();
      expect(screen.getByText(copy.delivery.failed)).toBeOnTheScreen();
    });
  });

  describe('history', () => {
    it('loads older messages as the user scrolls back, never showing one twice', async () => {
      replies[`GET ${MESSAGES}`] = {
        body: page(
          [message('m-4', { body: 'Dördüncü' }), message('m-3', { body: 'Üçüncü' })],
          'cursor-1',
        ),
      };
      // The older page overlaps the first by one message — the merge must hold.
      replies[`GET ${MESSAGES}?cursor=cursor-1`] = {
        body: page([
          message('m-3', { body: 'Üçüncü' }),
          message('m-2', { body: 'İkinci' }),
          message('m-1', { body: 'Birinci' }),
        ]),
      };
      await mount();
      await screen.findByText('Dördüncü');

      await act(async () => {
        await fireEvent(screen.getByTestId('conversation-messages'), 'endReached');
        await Promise.resolve();
      });

      expect(await screen.findByText('Birinci')).toBeOnTheScreen();
      expect(screen.getByText('İkinci')).toBeOnTheScreen();
      expect(screen.getAllByText('Üçüncü')).toHaveLength(1);
      expect(screen.getAllByText('Dördüncü')).toHaveLength(1);
    });

    it('asks for nothing older once the server says there is nothing', async () => {
      replies[`GET ${MESSAGES}`] = { body: page([message('m-1', { body: 'Tək' })]) };
      await mount();
      await screen.findByText('Tək');

      await act(async () => {
        await fireEvent(screen.getByTestId('conversation-messages'), 'endReached');
        await Promise.resolve();
      });

      expect(requests('GET', MESSAGES)).toHaveLength(1);
    });
  });

  describe('live', () => {
    it('shows a message the other party wrote without refetching the history', async () => {
      await mount();
      await screen.findByText(copy.emptyTitle);
      const before = requests('GET', MESSAGES).length;

      await publish(sockets(), MESSAGE_NEW_EVENT, {
        orderId: ORDER_ID,
        message: message('m-5', { body: 'Qapının qarşısındayam.' }),
        at: 5_000,
      } satisfies MessageNewRealtimeEvent);

      expect(await screen.findByText('Qapının qarşısındayam.')).toBeOnTheScreen();
      expect(requests('GET', MESSAGES)).toHaveLength(before);
    });

    it('marks my messages read when the other party reads them', async () => {
      replies[`GET ${MESSAGES}`] = {
        body: page([
          message('m-2', {
            senderKind: 'customer',
            body: 'İkinci',
            createdAt: '2026-09-23T08:02:00.000Z',
          }),
          message('m-1', {
            senderKind: 'customer',
            body: 'Birinci',
            createdAt: '2026-09-23T08:01:00.000Z',
          }),
        ]),
      };
      await mount();
      await screen.findByText('İkinci');

      await publish(sockets(), MESSAGE_READ_EVENT, {
        orderId: ORDER_ID,
        readerKind: 'master',
        throughMessageId: 'm-1',
        readAt: '2026-09-23T08:03:00.000Z',
        at: 6_000,
      } satisfies MessageReadRealtimeEvent);

      // Read up to and including m-1, and not the newer m-2.
      expect(
        await screen.findByText(
          mine(formatMessageTime('2026-09-23T08:01:00.000Z'), copy.delivery.read),
        ),
      ).toBeOnTheScreen();
      expect(
        screen.getByText(mine(formatMessageTime('2026-09-23T08:02:00.000Z'), copy.delivery.sent)),
      ).toBeOnTheScreen();
    });

    it('refetches the history after the connection comes back', async () => {
      await mount();
      await screen.findByText(copy.emptyTitle);
      replies[`GET ${MESSAGES}`] = { body: page([message('m-7', { body: 'Boşluqda yazılıb.' })]) };

      await actAndSettle(() => {
        sockets().latest().serverDisconnect();
      });
      await actAndSettle(() => {
        sockets().latest().serverConnect();
      });

      expect(await screen.findByText('Boşluqda yazılıb.')).toBeOnTheScreen();
    });
  });

  describe('a finished order', () => {
    it('shows the transcript and no composer at all', async () => {
      replies[`GET /orders/${ORDER_ID}/conversation`] = {
        body: conversation({ writable: false }),
      };
      replies[`GET ${MESSAGES}`] = { body: page([message('m-1', { body: 'İş bitdi.' })]) };
      await mount();

      expect(await screen.findByText('İş bitdi.')).toBeOnTheScreen();
      expect(screen.getByText(copy.closedNotice)).toBeOnTheScreen();
      expect(screen.queryByLabelText(copy.composerLabel)).toBeNull();
      expect(screen.queryByRole('button', { name: copy.send })).toBeNull();
    });
  });

  describe('read receipts', () => {
    const incoming = [
      message('m-3', { body: 'Üç', createdAt: '2026-09-23T08:03:00.000Z' }),
      message('m-2', { body: 'İki', createdAt: '2026-09-23T08:02:00.000Z' }),
    ];

    beforeEach(() => {
      replies[`GET /orders/${ORDER_ID}/conversation`] = { body: conversation({ unreadCount: 2 }) };
      replies[`GET ${MESSAGES}`] = { body: page(incoming) };
    });

    it('are not sent just because the screen opened', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      await mount();
      await screen.findByText('Üç');

      await act(async () => {
        jest.advanceTimersByTime(READ_RECEIPT_DELAY_MS * 4);
        await Promise.resolve();
      });

      expect(requests('POST', READ)).toHaveLength(0);
    });

    it('are sent once, for the newest message the user has seen', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      await mount();
      await screen.findByText('Üç');

      await comeIntoView([incoming[1] as Message]);
      await comeIntoView(incoming);
      await act(async () => {
        jest.advanceTimersByTime(READ_RECEIPT_DELAY_MS);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(requests('POST', READ).map((call) => call.body)).toEqual([
          { throughMessageId: 'm-3' },
        ]);
      });
    });

    it('are not sent for the user’s own messages', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      await mount('master');
      await screen.findByText('Üç');

      await comeIntoView(incoming);
      await act(async () => {
        jest.advanceTimersByTime(READ_RECEIPT_DELAY_MS * 2);
        await Promise.resolve();
      });

      expect(requests('POST', READ)).toHaveLength(0);
    });
  });

  describe('typing', () => {
    it('shows the other party typing, and lets it lapse', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      await mount();
      await screen.findByText(copy.emptyTitle);

      await publish(sockets(), CONVERSATION_TYPING_EVENT, { orderId: ORDER_ID, at: 7_000 });
      // RTK batches store notifications to the next animation frame, which
      // under fake time arrives only when the clock moves.
      await elapse(ANIMATION_FRAME_MS);
      expect(screen.getByText(copy.typing.master)).toBeOnTheScreen();

      await elapse(TYPING_LAPSE_MS / 2);
      expect(screen.getByText(copy.typing.master)).toBeOnTheScreen();

      await elapse(TYPING_LAPSE_MS);
      expect(screen.queryByText(copy.typing.master)).toBeNull();
    });

    it('tells the other party this user is typing, without a frame per keystroke', async () => {
      await mount();
      await screen.findByText(copy.emptyTitle);

      await type('S');
      await type('Sa');
      await type('Sal');

      const typingFrames = sockets()
        .latest()
        .emitted.filter((frame) => frame.event === CONVERSATION_TYPING_EVENT);
      expect(typingFrames).toEqual([
        { event: CONVERSATION_TYPING_EVENT, payload: { orderId: ORDER_ID } },
      ]);
    });
  });

  it('goes back', async () => {
    const { onBack } = await mount();

    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: copy.back }));
      await Promise.resolve();
    });

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
