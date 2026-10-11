import type { MasterSubscription } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { MASTER_SUBSCRIPTION_COPY as copy } from './master-subscription-copy';
import { SubscriptionCard } from './SubscriptionCard';
import { SubscriptionDetails } from './SubscriptionDetails';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const NOW = new Date('2027-03-10T12:00:00Z');
const DAY = 86_400_000;

function subscription(overrides: Partial<MasterSubscription> = {}): MasterSubscription {
  return {
    status: 'active',
    billingPeriod: 'monthly',
    currentPeriodStart: '2027-03-01T12:00:00.000Z',
    currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY).toISOString(),
    graceEndsAt: null,
    nextBillingPeriod: null,
    entitled: true,
    ...overrides,
  };
}

interface Reply {
  readonly body?: unknown;
  readonly status?: number;
}

let reply: Reply = {};
let calls = 0;

function installTransport(): void {
  global.fetch = ((input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    if (new URL(request.url).pathname === '/masters/me/subscription') {
      calls += 1;
    }
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  reply = {};
  calls = 0;
  installTransport();
});

async function mountCard(onOpen = jest.fn()): Promise<jest.Mock> {
  await render(
    <Provider store={createTestStore()}>
      <SubscriptionCard onOpen={onOpen} now={NOW} />
    </Provider>,
  );
  return onOpen;
}

async function mountDetails(): Promise<void> {
  await render(
    <Provider store={createTestStore()}>
      <SubscriptionDetails onBack={jest.fn()} now={NOW} />
    </Provider>,
  );
}

describe('the subscription card on the master home (#325)', () => {
  it('shows a trial and when it ends', async () => {
    reply = { body: subscription({ status: 'trialing', billingPeriod: null }) };
    await mountCard();

    expect(await screen.findByText(copy.status.trialing)).toBeOnTheScreen();
    expect(screen.getByText(/tarixinədək/)).toBeOnTheScreen();
  });

  it('warns three days before the end', async () => {
    reply = {
      body: subscription({ currentPeriodEnd: new Date(NOW.getTime() + 2 * DAY).toISOString() }),
    };
    await mountCard();

    expect(await screen.findByText(/tarixində bitir/)).toBeOnTheScreen();
  });

  it('warns in grace, and once it has expired', async () => {
    reply = {
      body: subscription({
        status: 'past_due',
        currentPeriodEnd: new Date(NOW.getTime() - DAY).toISOString(),
        graceEndsAt: new Date(NOW.getTime() + 2 * DAY).toISOString(),
      }),
    };
    await mountCard();
    expect(await screen.findByText(copy.status.past_due)).toBeOnTheScreen();
    expect(screen.getByText(/Abunənizin müddəti bitib/)).toBeOnTheScreen();
  });

  it('says work has stopped for an expired subscription', async () => {
    reply = { body: subscription({ status: 'expired', entitled: false }) };
    await mountCard();

    expect(await screen.findByText(copy.warning.expired)).toBeOnTheScreen();
    expect(screen.getByText(copy.status.expired)).toBeOnTheScreen();
  });

  it('reads a 404 as "no subscription yet", not as an error', async () => {
    reply = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found.' } } };
    await mountCard();

    expect(await screen.findByText(copy.status.none)).toBeOnTheScreen();
    expect(screen.getByText(copy.line.none)).toBeOnTheScreen();
  });

  it('hides itself for a body it cannot read, rather than taking the home down', async () => {
    reply = { body: { unexpected: true } };
    await mountCard();

    // Settled, not merely sent: the skeleton is gone and no card replaced it.
    await waitFor(() => {
      expect(screen.queryByTestId('subscription-card-loading')).not.toBeOnTheScreen();
    });
    expect(calls).toBeGreaterThan(0);
    expect(screen.queryByText(copy.title)).not.toBeOnTheScreen();
  });

  it('opens the subscription screen', async () => {
    reply = { body: subscription() };
    const onOpen = await mountCard();

    void fireEvent.press(await screen.findByText(copy.title));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('the subscription screen (#325)', () => {
  it('shows the period, its end and that work is coming', async () => {
    reply = { body: subscription({ billingPeriod: 'yearly' }) };
    await mountDetails();

    expect(await screen.findByText(copy.period.yearly)).toBeOnTheScreen();
    expect(screen.getByText(copy.details.periodEnd)).toBeOnTheScreen();
    expect(screen.getByText(copy.details.yes)).toBeOnTheScreen();
  });

  it('explains a period paid in advance starts when the current one ends', async () => {
    reply = { body: subscription({ nextBillingPeriod: 'yearly' }) };
    await mountDetails();

    expect(await screen.findByText(copy.details.nextPeriod)).toBeOnTheScreen();
    expect(screen.getByText(copy.details.queuedExplanation)).toBeOnTheScreen();
  });

  it('shows the grace end in grace', async () => {
    reply = {
      body: subscription({
        status: 'past_due',
        currentPeriodEnd: new Date(NOW.getTime() - DAY).toISOString(),
        graceEndsAt: new Date(NOW.getTime() + 2 * DAY).toISOString(),
      }),
    };
    await mountDetails();

    expect(await screen.findByText(copy.details.graceEnd)).toBeOnTheScreen();
  });

  it('says how renewing works, with no price, link or button to buy', async () => {
    reply = { body: subscription() };
    await mountDetails();

    expect(await screen.findByText(copy.details.howToRenew)).toBeOnTheScreen();
    expect(screen.queryByText(/₼|AZN/)).not.toBeOnTheScreen();
    expect(screen.queryByRole('link')).not.toBeOnTheScreen();
  });

  it('offers a retry when the read fails, and asks again', async () => {
    // A 4xx other than 404: the base query retries a 5xx with real backoff,
    // and what is under test is the screen's own retry, not that one.
    reply = { status: 403, body: { error: { code: 'FORBIDDEN', message: 'x' } } };
    await mountDetails();

    expect(await screen.findByText(copy.loadFailed)).toBeOnTheScreen();
    const before = calls;
    reply = { body: subscription() };
    void fireEvent.press(screen.getByText(copy.retry));
    await waitFor(() => {
      expect(screen.getByText(copy.details.periodEnd)).toBeOnTheScreen();
    });
    expect(calls).toBeGreaterThan(before);
  });
});
