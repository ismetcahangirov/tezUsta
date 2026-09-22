import type { NotificationPreference } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { NotificationPreferences } from './NotificationPreferences';
import { notificationsCopy } from './notifications-copy';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockPermission = { current: 'granted' as 'granted' | 'askable' | 'blocked' };
const mockOpenSettings = jest.fn();

jest.mock('./useOsNotificationPermission', () => ({
  useOsNotificationPermission: () => ({
    permission: mockPermission.current,
    openSystemSettings: mockOpenSettings,
  }),
}));

const copy = notificationsCopy.preferences;

const PREFERENCES: NotificationPreference[] = [
  { category: 'order-offers', enabled: true, changeable: false },
  { category: 'order-progress', enabled: true, changeable: true },
  { category: 'order-cancelled', enabled: true, changeable: false },
];

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
}

let replies: Record<string, Reply> = {};
let sent: { method: string; body: string }[] = [];

function installTransport(): void {
  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    sent.push({ method: request.method, body: await request.clone().text() });

    const reply = replies[request.method] ?? { status: 200, body: PREFERENCES };

    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function mount(): Promise<unknown> {
  return render(
    <Provider store={createTestStore()}>
      <NotificationPreferences />
    </Provider>,
  );
}

describe('NotificationPreferences', () => {
  beforeEach(() => {
    replies = {};
    sent = [];
    mockPermission.current = 'granted';
    mockOpenSettings.mockClear();
    installTransport();
  });

  it('renders every category the server returned, and nothing it did not', async () => {
    await mount();

    await waitFor(() => {
      expect(screen.getByText(notificationsCopy.categories['order-offers'].title)).toBeTruthy();
    });
    expect(screen.getByText(notificationsCopy.categories['order-progress'].title)).toBeTruthy();
    expect(screen.getByText(notificationsCopy.categories['order-cancelled'].title)).toBeTruthy();
    // Present in the app's copy table, absent from this server response.
    expect(
      screen.queryByText(notificationsCopy.categories['order-no-master-found'].title),
    ).toBeNull();
  });

  it('switches a category off and tells the server', async () => {
    await mount();

    await waitFor(() => {
      expect(screen.getByText(notificationsCopy.categories['order-progress'].title)).toBeTruthy();
    });

    replies['PUT'] = {
      body: PREFERENCES.map((entry) =>
        entry.category === 'order-progress' ? { ...entry, enabled: false } : entry,
      ),
    };

    await fireEvent.press(screen.getAllByText(copy.off)[0] as never);

    await waitFor(() => {
      expect(sent.some((request) => request.method === 'PUT')).toBe(true);
    });

    const put = sent.find((request) => request.method === 'PUT');
    expect(JSON.parse(put?.body ?? '{}')).toEqual({
      preferences: [
        { category: 'order-offers', enabled: true },
        { category: 'order-progress', enabled: false },
        { category: 'order-cancelled', enabled: true },
      ],
    });
  });

  it('rolls the toggle back and says so when the write fails', async () => {
    // The case nobody exercises by hand, and the one where a silent failure
    // leaves the user believing a setting they do not have.
    await mount();

    await waitFor(() => {
      expect(screen.getByText(notificationsCopy.categories['order-progress'].title)).toBeTruthy();
    });

    replies['PUT'] = { status: 500, body: { code: 'INTERNAL' } };

    await fireEvent.press(screen.getAllByText(copy.off)[0] as never);

    // A 5xx is retried with real backoff by `src/api/base-query.ts` — only a
    // 4xx is settled on the first answer — so the failure takes longer to
    // become visible than the default timeout allows.
    await waitFor(
      () => {
        expect(screen.getByText(copy.saveFailed)).toBeTruthy();
      },
      { timeout: 15_000 },
    );

    // Back on, because the server never accepted it being off.
    await waitFor(() => {
      expect(
        screen.getByLabelText(
          `${notificationsCopy.categories['order-progress'].title}: ${copy.on}`,
        ),
      ).toBeTruthy();
    });
  });

  it('shows a locked category with its reason and no control', async () => {
    await mount();

    await waitFor(() => {
      expect(screen.getByText(notificationsCopy.categories['order-offers'].title)).toBeTruthy();
    });

    expect(
      screen.getByText(notificationsCopy.categories['order-offers'].lockedReason),
    ).toBeTruthy();
    // Two locked categories, two pills, and no segmented control for either.
    expect(screen.getAllByText(copy.lockedPill)).toHaveLength(2);
    // One changeable category means exactly one pair of on/off segments.
    expect(screen.getAllByText(copy.on)).toHaveLength(1);
  });

  it('says so and offers the way out when the OS is blocking notifications', async () => {
    mockPermission.current = 'blocked';
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.osBlocked)).toBeTruthy();
    });

    await fireEvent.press(screen.getByText(copy.openSystemSettings));

    expect(mockOpenSettings).toHaveBeenCalled();
  });

  it('says nothing about the OS when notifications are permitted', async () => {
    await mount();

    await waitFor(() => {
      expect(screen.getByText(notificationsCopy.categories['order-progress'].title)).toBeTruthy();
    });

    expect(screen.queryByText(copy.osBlocked)).toBeNull();
  });

  it('offers a retry when the list could not be loaded', async () => {
    replies['GET'] = { status: 500, body: { code: 'INTERNAL' } };
    await mount();

    await waitFor(
      () => {
        expect(screen.getByText(copy.loadFailed)).toBeTruthy();
      },
      { timeout: 15_000 },
    );
    expect(screen.getByText(copy.retry)).toBeTruthy();
  });

  it('names a category the app has never been taught rather than dropping it', async () => {
    // A category added on the server reaches the app without a release. It
    // renders under its own key until somebody writes it a name — a toggle
    // that vanished would read as a missing feature.
    replies['GET'] = {
      body: [{ category: 'order-digest', enabled: true, changeable: true }],
    };
    await mount();

    await waitFor(() => {
      expect(screen.getByText('order-digest')).toBeTruthy();
    });
  });
});
