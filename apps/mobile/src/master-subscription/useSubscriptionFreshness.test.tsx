import type { MasterSubscription } from '@tezusta/types';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { MASTER_SUBSCRIPTION_COPY as copy } from './master-subscription-copy';
import { SubscriptionCard } from './SubscriptionCard';
import { useSubscriptionFreshness } from './useSubscriptionFreshness';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

let arrive: (data: unknown) => void = () => undefined;

jest.mock('../notifications/push-adapter', () => ({
  ...jest.requireActual<object>('../notifications/push-adapter'),
  subscribeToForegroundNotifications: (onReceive: (data: unknown) => void) => {
    arrive = onReceive;
    return { remove: jest.fn() };
  },
}));

const NOW = new Date('2027-03-10T12:00:00Z');

const RUNNING: MasterSubscription = {
  status: 'active',
  billingPeriod: 'monthly',
  currentPeriodStart: '2027-03-01T12:00:00.000Z',
  currentPeriodEnd: '2027-03-30T12:00:00.000Z',
  graceEndsAt: null,
  nextBillingPeriod: null,
  entitled: true,
};

let reads = 0;
/** Restored one by one: `restoreAllMocks` would also strip the module mocks' implementations. */
let spies: jest.SpyInstance[] = [];
let resume: (state: AppStateStatus) => void = () => undefined;

function Home(): React.JSX.Element {
  useSubscriptionFreshness();
  return <SubscriptionCard onOpen={jest.fn()} now={NOW} />;
}

beforeEach(() => {
  reads = 0;
  global.fetch = ((input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    if (new URL(request.url).pathname === '/masters/me/subscription') {
      reads += 1;
    }
    return Promise.resolve(
      new Response(JSON.stringify(RUNNING), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  spies = [
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      resume = listener;
      return { remove: jest.fn() };
    }),
  ];
});

afterEach(() => {
  spies.forEach((spy) => {
    spy.mockRestore();
  });
});

async function mountHome(): Promise<void> {
  await render(
    <Provider store={createTestStore()}>
      <Home />
    </Provider>,
  );
  expect(await screen.findByText(copy.title)).toBeOnTheScreen();
  expect(reads).toBe(1);
}

describe('useSubscriptionFreshness (#325)', () => {
  it('reads the subscription again when a subscription push arrives in the foreground', async () => {
    await mountHome();

    // A payload this app cannot read is no reason to ask.
    await act(() => {
      arrive({ kind: 'nope' });
    });
    await act(() => {
      arrive({ kind: 'subscription-expired' });
    });

    await waitFor(() => {
      expect(reads).toBe(2);
    });
  });

  it('reads it again on coming back from another app, but not within the freshness window', async () => {
    await mountHome();

    await act(() => {
      resume('active');
    });
    const later = Date.now() + 31_000;
    spies.push(jest.spyOn(Date, 'now').mockReturnValue(later));
    await act(() => {
      resume('background');
    });
    await act(() => {
      resume('active');
    });

    await waitFor(() => {
      expect(reads).toBe(2);
    });
  });
});
