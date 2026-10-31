import type { MasterSubscription, SubscriptionOffer } from '@tezusta/types';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiError, type FakeServer, installFakeServer } from '../test/fake-server';
import { renderApp } from '../test/render-app';
import { browser, readSnapshot, saveSnapshot } from './checkout-handoff';
import { copy } from './copy';
import { formatDate, formatMoney } from './format';

const SUBSCRIPTION = '/api/masters/me/subscription';
const RENEWAL = '/api/masters/me/subscription/auto-renewal';
const CHECKOUT = '/api/masters/me/subscription/checkout';
const OFFER = '/api/subscription';

function subscription(overrides: Partial<MasterSubscription> = {}): MasterSubscription {
  return {
    status: 'active',
    billingPeriod: 'monthly',
    currentPeriodStart: '2026-10-01T00:00:00.000Z',
    currentPeriodEnd: '2026-11-01T00:00:00.000Z',
    graceEndsAt: null,
    nextBillingPeriod: null,
    entitled: true,
    ...overrides,
  };
}

function offer(overrides: Partial<SubscriptionOffer> = {}): SubscriptionOffer {
  return {
    monthly: {
      billingPeriod: 'monthly',
      priceMinor: 1500,
      currency: 'AZN',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
    },
    yearly: {
      billingPeriod: 'yearly',
      priceMinor: 15000,
      currency: 'AZN',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
    },
    trialDays: 14,
    graceDays: 3,
    purchasesOpen: true,
    ...overrides,
  };
}

/**
 * Testing Library collapses the no-break space `Intl` puts before `₼`, but
 * not in the string it is asked to find.
 */
function shown(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** A master already signed in: every subscription route answers. */
function signedInServer(
  options: {
    subscription?: MasterSubscription | 'none';
    offer?: SubscriptionOffer;
  } = {},
): FakeServer {
  const server = installFakeServer();
  server.on(
    'GET',
    SUBSCRIPTION,
    options.subscription === 'none'
      ? apiError(404, 'NOT_FOUND')
      : { status: 200, body: options.subscription ?? subscription() },
  );
  server.on('GET', OFFER, { status: 200, body: options.offer ?? offer() });
  server.on('GET', RENEWAL, { status: 200, body: { enabled: false } });
  return server;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('signing in (ADR-0061 § 2)', () => {
  it('shows the sign-in form when there is no session, and opens the page once the code is right', async () => {
    const server = installFakeServer();
    server.on('GET', SUBSCRIPTION, apiError(401, 'UNAUTHORIZED'), {
      status: 200,
      body: subscription(),
    });
    server.on('GET', OFFER, apiError(401, 'UNAUTHORIZED'), { status: 200, body: offer() });
    server.on('GET', RENEWAL, { status: 200, body: { enabled: false } });
    server.on('POST', '/api/web/auth/refresh', apiError(401, 'UNAUTHORIZED'));
    server.on('POST', '/api/web/auth/otp/request', {
      status: 200,
      body: { expiresInSeconds: 300 },
    });
    server.on('POST', '/api/web/auth/otp/verify', {
      status: 200,
      body: { sessionExpiresAt: '2026-10-24T08:00:00.000Z' },
    });

    const { user } = renderApp('/');

    await user.type(await screen.findByLabelText(copy.signIn.email), '  usta@example.com ');
    await user.click(screen.getByRole('button', { name: copy.signIn.sendCode }));
    expect(await screen.findByText(copy.signIn.codeSent)).toBeInTheDocument();

    await user.type(screen.getByLabelText(copy.signIn.code), '123456');
    await user.click(screen.getByRole('button', { name: copy.signIn.verify }));

    expect(await screen.findByText(copy.subscription.status.active)).toBeInTheDocument();
    expect(server.calls('POST', '/api/web/auth/otp/request')[0]?.body).toEqual({
      email: 'usta@example.com',
    });
    expect(server.calls('POST', '/api/web/auth/otp/verify')[0]?.body).toEqual({
      email: 'usta@example.com',
      code: '123456',
    });
  });

  it('asks again for an address that is not shaped like one, without sending it', async () => {
    const server = installFakeServer();
    server.on('GET', SUBSCRIPTION, apiError(401, 'UNAUTHORIZED'));
    server.on('GET', OFFER, apiError(401, 'UNAUTHORIZED'));
    server.on('POST', '/api/web/auth/refresh', apiError(401, 'UNAUTHORIZED'));
    server.on('POST', '/api/web/auth/otp/request', {
      status: 200,
      body: { expiresInSeconds: 300 },
    });

    const { user } = renderApp('/');
    const field = await screen.findByLabelText(copy.signIn.email);
    await user.type(field, 'usta@example');
    await user.click(screen.getByRole('button', { name: copy.signIn.sendCode }));

    expect(await screen.findByText(copy.signIn.invalidEmail)).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(server.calls('POST', '/api/web/auth/otp/request')).toHaveLength(0);

    await user.type(field, '.com');
    expect(screen.queryByText(copy.signIn.invalidEmail)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.signIn.sendCode }));
    expect(await screen.findByText(copy.signIn.codeSent)).toBeInTheDocument();
    expect(server.calls('POST', '/api/web/auth/otp/request')[0]?.body).toEqual({
      email: 'usta@example.com',
    });
  });

  it('sends every request to its own origin, with the cookies and the CSRF header', async () => {
    const server = signedInServer();

    renderApp('/');
    await screen.findByText(copy.subscription.status.active);

    expect(server.requests.length).toBeGreaterThan(0);
    for (const request of server.requests) {
      expect(request.origin).toBe(window.location.origin);
      expect(request.path.startsWith('/api/')).toBe(true);
      expect(request.credentials).toBe('same-origin');
      expect(request.headers.get('x-tezusta-web')).toBe('1');
    }
  });

  it('says a wrong code is wrong, the same way for any address', async () => {
    const server = installFakeServer();
    server.on('GET', SUBSCRIPTION, apiError(401, 'UNAUTHORIZED'));
    server.on('GET', OFFER, apiError(401, 'UNAUTHORIZED'));
    server.on('POST', '/api/web/auth/refresh', apiError(401, 'UNAUTHORIZED'));
    server.on('POST', '/api/web/auth/otp/request', {
      status: 200,
      body: { expiresInSeconds: 300 },
    });
    server.on('POST', '/api/web/auth/otp/verify', apiError(401, 'UNAUTHORIZED'));

    const { user } = renderApp('/');
    await user.type(await screen.findByLabelText(copy.signIn.email), 'usta@example.com');
    await user.click(screen.getByRole('button', { name: copy.signIn.sendCode }));
    await user.type(await screen.findByLabelText(copy.signIn.code), '000000');
    await user.click(screen.getByRole('button', { name: copy.signIn.verify }));

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.signIn.wrongCode);
  });

  it('ends the session on sign-out and shows the form again', async () => {
    const server = signedInServer();
    server.on('POST', '/api/web/auth/sign-out', { status: 204 });

    const { user } = renderApp('/');
    await user.click(await screen.findByRole('button', { name: copy.subscription.signOut }));

    expect(await screen.findByLabelText(copy.signIn.email)).toBeInTheDocument();
    expect(server.calls('POST', '/api/web/auth/sign-out')).toHaveLength(1);
  });
});

describe('the subscription (ADR-0061 § 6)', () => {
  it('shows the status, the period end, grace and a queued period', async () => {
    signedInServer({
      subscription: subscription({
        status: 'past_due',
        graceEndsAt: '2026-11-04T00:00:00.000Z',
        nextBillingPeriod: 'yearly',
      }),
    });

    renderApp('/');

    expect(await screen.findByText(copy.subscription.status.past_due)).toBeInTheDocument();
    expect(
      screen.getByText(copy.subscription.periodEnds(formatDate('2026-11-01T00:00:00.000Z'))),
    ).toBeInTheDocument();
    expect(
      screen.getByText(copy.subscription.graceEnds(formatDate('2026-11-04T00:00:00.000Z'))),
    ).toBeInTheDocument();
    expect(screen.getByText(copy.subscription.nextQueued('yearly'))).toBeInTheDocument();
  });

  it('tells a master verification has not approved why there is no subscription, and that checkout is refused', async () => {
    const server = signedInServer({ subscription: 'none' });
    server.on('POST', CHECKOUT, apiError(409, 'CONFLICT'));

    const { user } = renderApp('/');

    expect(await screen.findByText(copy.subscription.notVerified)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.subscription.pay }));
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.subscription.notEligible);
  });

  it('offers nothing while purchases are closed', async () => {
    signedInServer({ offer: offer({ purchasesOpen: false, monthly: null, yearly: null }) });

    renderApp('/');

    expect(await screen.findByText(copy.subscription.purchasesClosed)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.subscription.pay })).not.toBeInTheDocument();
  });

  it('turns auto-renewal off, which is what cancelling means', async () => {
    const server = signedInServer();
    server.on(
      'GET',
      RENEWAL,
      { status: 200, body: { enabled: true } },
      { status: 200, body: { enabled: false } },
    );
    server.on('DELETE', RENEWAL, { status: 204 });

    const { user } = renderApp('/');
    await user.click(await screen.findByRole('button', { name: copy.subscription.turnOff }));

    expect(await screen.findByText(copy.subscription.renewalOff)).toBeInTheDocument();
    expect(server.calls('DELETE', RENEWAL)).toHaveLength(1);
  });
});

describe('buying a period', () => {
  it('shows both prices, keeps auto-renewal off unless asked, and leaves for the provider', async () => {
    const server = signedInServer();
    server.on('POST', CHECKOUT, {
      status: 201,
      body: {
        checkoutUrl: 'https://pay.example.test/checkout/abc',
        billingPeriod: 'yearly',
        amountMinor: 15000,
        currency: 'AZN',
        autoRenew: true,
        createdAt: '2026-10-23T08:00:00.000Z',
      },
    });
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => undefined);

    const { user } = renderApp('/');

    expect(
      await screen.findByText(shown(copy.subscription.price(formatMoney(1500), 'monthly'))),
    ).toBeInTheDocument();
    expect(
      screen.getByText(shown(copy.subscription.price(formatMoney(15000), 'yearly'))),
    ).toBeInTheDocument();
    const consent = screen.getByRole('checkbox', { name: copy.subscription.autoRenewConsent });
    expect(consent).not.toBeChecked();

    await user.click(screen.getByRole('radio', { name: /İllik/ }));
    await user.click(consent);
    await user.click(screen.getByRole('button', { name: copy.subscription.pay }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://pay.example.test/checkout/abc'),
    );
    expect(server.calls('POST', CHECKOUT)[0]?.body).toEqual({
      billingPeriod: 'yearly',
      autoRenew: true,
    });
    expect(readSnapshot()).toEqual({
      status: 'active',
      currentPeriodEnd: '2026-11-01T00:00:00.000Z',
      nextBillingPeriod: null,
    });
  });

  it('never follows a checkout address that is not https', async () => {
    const server = signedInServer();
    server.on('POST', CHECKOUT, {
      status: 201,
      body: {
        checkoutUrl: 'javascript:alert(1)',
        billingPeriod: 'monthly',
        amountMinor: 1500,
        currency: 'AZN',
        autoRenew: false,
        createdAt: '2026-10-23T08:00:00.000Z',
      },
    });
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => undefined);

    const { user } = renderApp('/');
    await user.click(await screen.findByRole('button', { name: copy.subscription.pay }));

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.unexpected);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('coming back from the provider (ADR-0061 § 6)', () => {
  const FAST = { pollMs: 20, waitMs: 400 };

  it('confirms once the subscription has actually changed, not because the browser came back', async () => {
    const before = subscription();
    saveSnapshot(before);
    const server = signedInServer();
    server.on(
      'GET',
      SUBSCRIPTION,
      { status: 200, body: before },
      { status: 200, body: before },
      { status: 200, body: subscription({ currentPeriodEnd: '2026-12-01T00:00:00.000Z' }) },
    );

    renderApp('/return', FAST);

    expect(await screen.findByText(copy.return.confirming)).toBeInTheDocument();
    expect(await screen.findByText(copy.return.confirmed)).toBeInTheDocument();
    expect(readSnapshot()).toBeUndefined();
  });

  it('stops asking after a bounded wait and says the payment will appear once confirmed', async () => {
    const before = subscription();
    saveSnapshot(before);
    const server = signedInServer({ subscription: before });

    renderApp('/return', FAST);

    expect(await screen.findByText(copy.return.pending)).toBeInTheDocument();
    // A poll sent just before the wait ran out is still in flight when the
    // pending line renders, and the fake server records it only after reading
    // its body. Let it land before counting, or it reads as a poll sent after
    // the stop (CI saw 20 against 19). Five poll intervals then prove the stop.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const asked = server.calls('GET', SUBSCRIPTION).length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.calls('GET', SUBSCRIPTION).length).toBe(asked);
  });

  it('does not claim a payment it has nothing to compare against', async () => {
    signedInServer();

    renderApp('/return', FAST);

    expect(await screen.findByText(copy.return.pending)).toBeInTheDocument();
    expect(screen.queryByText(copy.return.confirmed)).not.toBeInTheDocument();
  });
});
