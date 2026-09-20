import type { MasterAvailability } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { AvailabilityCard } from './AvailabilityCard';
import { MASTER_AVAILABILITY_COPY as copy } from './master-availability-copy';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const OFFLINE: MasterAvailability = {
  isAvailable: false,
  isLive: false,
  expiresInSeconds: null,
  // Long, so the heartbeat loop never fires inside a test. What the interval
  // does is `useAvailabilityHeartbeat`'s business; this file is about the card.
  heartbeatSeconds: 3600,
};

const ONLINE: MasterAvailability = {
  isAvailable: true,
  isLive: true,
  expiresInSeconds: 170,
  heartbeatSeconds: 3600,
};

interface Reply {
  readonly body?: unknown;
  readonly status?: number;
  /** Never settles, so the request stays in flight. */
  readonly pending?: true;
}

let replies: Record<string, Reply> = {};
/** Every request the card made, so a test can assert what was sent. */
let sent: { method: string; path: string; body: string | null }[] = [];

/**
 * Drives the real api slice through the real base query; only `fetch` is
 * faked, the same way `ServiceCatalogue.test.tsx` and `auth-endpoints.test.ts`
 * do it. Keyed by `METHOD path` so the GET and the POST on one path can answer
 * differently.
 */
function installTransport(): void {
  global.fetch = (async (input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    const body = typeof init?.body === 'string' ? init.body : await request.clone().text();
    sent.push({ method: request.method, path: url.pathname, body: body === '' ? null : body });

    const reply = replies[key] ?? { body: OFFLINE };
    if (reply.pending === true) {
      return new Promise<Response>(() => undefined);
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

async function mount(): Promise<void> {
  installTransport();
  const store = createTestStore();
  await render(
    <Provider store={store}>
      <AvailabilityCard />
    </Provider>,
  );
}

beforeEach(() => {
  replies = {};
  sent = [];
});

describe('AvailabilityCard', () => {
  it('shows the state the server reports, not one the client assumed', async () => {
    replies['GET /masters/me/availability'] = { body: ONLINE };
    // The heartbeat beats *immediately* on becoming online, not after one
    // interval (`useAvailabilityHeartbeat`), so this test makes a POST it did
    // not ask for — and an unconfigured path answers with the `OFFLINE`
    // default, whose reply carries the whole state and flips the card back.
    // Whichever response lands last wins, which made this a race the
    // assertion happened to win on a fast machine and lose on a loaded CI
    // worker. Same reason the toggle test below pins this path.
    replies['POST /masters/me/availability/heartbeat'] = { body: ONLINE };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.liveLabel)).toBeOnTheScreen();
    });
  });

  it('shows a placeholder while the state is still loading', async () => {
    replies['GET /masters/me/availability'] = { pending: true };
    await mount();

    expect(screen.queryByText(copy.liveLabel)).not.toBeOnTheScreen();
    expect(screen.queryByText(copy.offlineLabel)).not.toBeOnTheScreen();
  });

  it('asks the server to go online, and renders what it answers', async () => {
    replies['GET /masters/me/availability'] = { body: OFFLINE };
    replies['POST /masters/me/availability'] = { body: ONLINE };
    // The card beats as soon as the server says the master is online, and the
    // beat answers with the state too — so the fake has to answer it with the
    // same state, or the heartbeat would overwrite what the toggle just set.
    // That is the real contract, not a test artefact: every response on this
    // feature carries the whole state, so whichever lands last is still right.
    replies['POST /masters/me/availability/heartbeat'] = { body: ONLINE };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.offlineLabel)).toBeOnTheScreen();
    });

    void fireEvent.press(screen.getByText(copy.online));

    await waitFor(() => {
      expect(screen.getByText(copy.liveLabel)).toBeOnTheScreen();
    });
    expect(
      sent.some(
        (request) =>
          request.method === 'POST' &&
          request.path === '/masters/me/availability' &&
          request.body === JSON.stringify({ isAvailable: true }),
      ),
    ).toBe(true);
  });

  /**
   * The server refuses, and the card must say **why** rather than silently
   * snapping the toggle back. `changes_requested` and `rejected` are different
   * states with different screens (`docs/product/master-flow.md`), so the
   * reason is read from `details.verificationStatus` and rendered as its own
   * sentence.
   */
  it('explains a refusal to go online instead of just reverting the toggle', async () => {
    replies['GET /masters/me/availability'] = { body: OFFLINE };
    replies['POST /masters/me/availability'] = {
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: 'Your profile has not been verified yet, so you cannot take work.',
          details: { verificationStatus: 'pending_verification' },
          requestId: 'test',
        },
      },
    };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.offlineLabel)).toBeOnTheScreen();
    });

    void fireEvent.press(screen.getByText(copy.online));

    await waitFor(() => {
      expect(screen.getByText(copy.pendingVerification)).toBeOnTheScreen();
    });
    // And the master is still shown as offline, because they are.
    expect(screen.getByText(copy.offlineLabel)).toBeOnTheScreen();
  });

  it('warns when the stored intent and the live presence disagree', async () => {
    const stale = { ...ONLINE, isLive: false, expiresInSeconds: null };
    replies['GET /masters/me/availability'] = { body: stale };
    // The card beats because the intent says online; the server still reports
    // it as not live, which is exactly the situation being tested.
    replies['POST /masters/me/availability/heartbeat'] = { body: stale };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.staleDescription)).toBeOnTheScreen();
    });
  });

  it('offers a retry when the state cannot be read at all', async () => {
    replies['GET /masters/me/availability'] = {
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'nope', requestId: 'test' } },
    };
    await mount();

    await waitFor(
      () => {
        expect(screen.getByText(copy.loadFailed)).toBeOnTheScreen();
      },
      { timeout: 10_000 },
    );
    expect(screen.getByRole('button', { name: copy.retry })).toBeOnTheScreen();
  });
});
