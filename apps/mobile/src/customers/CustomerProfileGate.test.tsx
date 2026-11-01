import type { Customer } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { MASTER_ONBOARDING_COPY as roleCopy } from '../master-onboarding/master-onboarding-copy';
import type { AppRole } from '../store/session-slice';
import { signedIn } from '../store/session-slice';
import { CustomerProfileGate } from './CustomerProfileGate';
import { CUSTOMERS_COPY as copy } from './customers-copy';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/** A retried failure waits out a real backoff — see `Addresses.test.tsx`. */
const THROUGH_A_RETRY = { timeout: 10_000 };

const PROFILE: Customer = {
  id: 'cus-1',
  displayName: 'Aysel',
  avatarKey: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const CUSTOMER_AREA = 'the customer area';

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly transportError?: true;
}

let replies: Record<string, Reply> = {};
const requests: { method: string; pathname: string; body: string }[] = [];

function routeKey(method: string, pathname: string): string {
  return `${method} ${pathname}`;
}

function installTransport(): void {
  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      pathname: url.pathname,
      body: await request.clone().text(),
    });

    const reply = replies[routeKey(request.method, url.pathname)] ?? { status: 200, body: {} };
    if (reply.transportError === true) {
      return Promise.reject(new TypeError('Network request failed'));
    }

    return new Response(reply.body === undefined ? undefined : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

/**
 * `roles` are the grants the token carries. A brand-new account has none
 * (sign-in grants no role), which is what makes the gate ask which side it is
 * on before the name question (#490).
 */
async function mount(roles: readonly AppRole[] = []): Promise<void> {
  installTransport();
  const store = createTestStore();
  if (roles.length > 0) {
    store.dispatch(signedIn({ userId: 'user-1', roles }));
  }
  await render(
    <Provider store={store}>
      <CustomerProfileGate>
        <Text>{CUSTOMER_AREA}</Text>
      </CustomerProfileGate>
    </Provider>,
  );
}

/** Answers the brand-new account's first question with "I want to order". */
async function chooseCustomer(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText(roleCopy.choiceCustomer)).toBeOnTheScreen();
  });
  await fireEvent.press(screen.getByText(roleCopy.choiceCustomer));
}

/**
 * The gate between a signed-in account and the customer area (issue #94).
 *
 * The behaviours under test are the ones the issue's acceptance criteria name:
 * a brand-new account can get a profile without a manual API call, a returning
 * account is never asked again, and a failure that is not a 404 is not
 * mistaken for "you have no profile".
 */
describe('CustomerProfileGate', () => {
  beforeEach(() => {
    replies = {};
    requests.length = 0;
    mockPush.mockClear();
  });

  it('announces that it is checking while the first request is in flight', async () => {
    global.fetch = () => new Promise<Response>(() => undefined);
    await render(
      <Provider store={createTestStore()}>
        <CustomerProfileGate>
          <Text>{CUSTOMER_AREA}</Text>
        </CustomerProfileGate>
      </Provider>,
    );

    expect(screen.getByLabelText(copy.loading)).toBeOnTheScreen();
    // And the customer area is NOT rendered yet: every screen inside it would
    // fire its own request and get its own 404.
    expect(screen.queryByText(CUSTOMER_AREA)).not.toBeOnTheScreen();
  });

  it('renders the customer area for an account that already has a profile', async () => {
    replies[routeKey('GET', '/customers/me')] = { body: PROFILE };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(CUSTOMER_AREA)).toBeOnTheScreen();
    });
    // Never asked again — the acceptance criterion in as many words.
    expect(screen.queryByText(copy.setupTitle)).not.toBeOnTheScreen();
    expect(requests.some((sent) => sent.method === 'POST')).toBe(false);
  });

  it('asks a brand-new account for a name, then lets it in — no manual API call', async () => {
    replies[routeKey('GET', '/customers/me')] = {
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
    };
    replies[routeKey('POST', '/customers')] = { status: 201, body: PROFILE };
    await mount();
    await chooseCustomer();

    await waitFor(() => {
      expect(screen.getByText(copy.setupTitle)).toBeOnTheScreen();
    });

    await fireEvent.changeText(screen.getByLabelText(copy.nameField), 'Aysel');
    // The profile exists from here on, so the refetch the create invalidates
    // has to find one.
    replies[routeKey('GET', '/customers/me')] = { body: PROFILE };
    await fireEvent.press(screen.getByRole('button', { name: copy.setupAction }));

    await waitFor(() => {
      expect(screen.getByText(CUSTOMER_AREA)).toBeOnTheScreen();
    });

    const created = requests.find((sent) => sent.method === 'POST');
    expect(created?.pathname).toBe('/customers');
    expect(JSON.parse(created?.body ?? '{}')).toEqual({ displayName: 'Aysel' });
  });

  it('trims the name before sending it', async () => {
    replies[routeKey('GET', '/customers/me')] = { status: 404, body: {} };
    replies[routeKey('POST', '/customers')] = { status: 201, body: PROFILE };
    await mount();
    await chooseCustomer();

    await waitFor(() => {
      expect(screen.getByText(copy.setupTitle)).toBeOnTheScreen();
    });
    await fireEvent.changeText(screen.getByLabelText(copy.nameField), '  Aysel  ');
    await fireEvent.press(screen.getByRole('button', { name: copy.setupAction }));

    await waitFor(() => {
      expect(requests.some((sent) => sent.method === 'POST')).toBe(true);
    });
    expect(JSON.parse(requests.find((sent) => sent.method === 'POST')?.body ?? '{}')).toEqual({
      displayName: 'Aysel',
    });
  });

  it('will not submit an empty or whitespace-only name', async () => {
    replies[routeKey('GET', '/customers/me')] = { status: 404, body: {} };
    await mount();
    await chooseCustomer();

    await waitFor(() => {
      expect(screen.getByText(copy.setupTitle)).toBeOnTheScreen();
    });
    await fireEvent.press(screen.getByRole('button', { name: copy.setupAction }));
    await fireEvent.changeText(screen.getByLabelText(copy.nameField), '   ');
    await fireEvent.press(screen.getByRole('button', { name: copy.setupAction }));

    expect(requests.some((sent) => sent.method === 'POST')).toBe(false);
  });

  it('treats a server failure as "try again", never as "you have no profile"', async () => {
    replies[routeKey('GET', '/customers/me')] = { status: 500, body: {} };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.errorTitle)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    // The distinction the whole gate turns on: a 500 must not produce the
    // first-run question, and must not post a profile.
    expect(screen.queryByText(copy.setupTitle)).not.toBeOnTheScreen();
    expect(requests.some((sent) => sent.method === 'POST')).toBe(false);
  }, 15_000);

  it('recovers when the retry succeeds', async () => {
    replies[routeKey('GET', '/customers/me')] = { transportError: true };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.errorTitle)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);

    replies[routeKey('GET', '/customers/me')] = { body: PROFILE };
    await fireEvent.press(screen.getByRole('button', { name: copy.retry }));

    await waitFor(() => {
      expect(screen.getByText(CUSTOMER_AREA)).toBeOnTheScreen();
    });
  }, 20_000);

  it('shows the field message a 422 carried, against the field', async () => {
    replies[routeKey('GET', '/customers/me')] = { status: 404, body: {} };
    replies[routeKey('POST', '/customers')] = {
      status: 422,
      body: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed.',
          details: { issues: [{ path: 'displayName', message: 'Too long' }] },
          requestId: 'req-1',
        },
      },
    };
    await mount();
    await chooseCustomer();

    await waitFor(() => {
      expect(screen.getByText(copy.setupTitle)).toBeOnTheScreen();
    });
    await fireEvent.changeText(screen.getByLabelText(copy.nameField), 'Aysel');
    await fireEvent.press(screen.getByRole('button', { name: copy.setupAction }));

    await waitFor(() => {
      expect(screen.getByText('Too long')).toBeOnTheScreen();
    });
    // A field problem is not a banner: the customer is still on the question,
    // and the message belongs next to what they have to change.
    expect(screen.queryByText(copy.saveError)).not.toBeOnTheScreen();
  }, 15_000);

  it('says the connection is gone when the create never reached the server', async () => {
    replies[routeKey('GET', '/customers/me')] = { status: 404, body: {} };
    replies[routeKey('POST', '/customers')] = { transportError: true };
    await mount();
    await chooseCustomer();

    await waitFor(() => {
      expect(screen.getByText(copy.setupTitle)).toBeOnTheScreen();
    });
    await fireEvent.changeText(screen.getByLabelText(copy.nameField), 'Aysel');
    await fireEvent.press(screen.getByRole('button', { name: copy.setupAction }));

    await waitFor(() => {
      expect(screen.getByText(copy.offlineError)).toBeOnTheScreen();
    }, THROUGH_A_RETRY);
    // The typed name survives, so the retry is one tap rather than a re-type.
    expect(screen.getByLabelText(copy.nameField).props.value).toBe('Aysel');
  }, 20_000);

  it('lets a retried create through — the server collapses it onto the same profile', async () => {
    // A reply that never arrived is the ordinary case, not an exotic one, and
    // `POST /customers` answers 200 with the existing row rather than 409.
    replies[routeKey('GET', '/customers/me')] = { status: 404, body: {} };
    replies[routeKey('POST', '/customers')] = { status: 200, body: PROFILE };
    await mount();
    await chooseCustomer();

    await waitFor(() => {
      expect(screen.getByText(copy.setupTitle)).toBeOnTheScreen();
    });
    await fireEvent.changeText(screen.getByLabelText(copy.nameField), 'Aysel');
    replies[routeKey('GET', '/customers/me')] = { body: PROFILE };
    await fireEvent.press(screen.getByRole('button', { name: copy.setupAction }));

    await waitFor(() => {
      expect(screen.getByText(CUSTOMER_AREA)).toBeOnTheScreen();
    });
  }, 15_000);

  describe('the first question a brand-new account answers (#490)', () => {
    it('asks whether the account wants to order or to work before asking a name', async () => {
      replies[routeKey('GET', '/customers/me')] = { status: 404, body: {} };
      await mount();

      await waitFor(() => {
        expect(screen.getByText(roleCopy.choiceTitle)).toBeOnTheScreen();
      });
      expect(screen.getByText(roleCopy.choiceMaster)).toBeOnTheScreen();
      expect(screen.queryByText(copy.setupTitle)).not.toBeOnTheScreen();
    });

    it('opens the master onboarding, without creating a customer profile', async () => {
      replies[routeKey('GET', '/customers/me')] = { status: 404, body: {} };
      await mount();

      await waitFor(() => {
        expect(screen.getByText(roleCopy.choiceMaster)).toBeOnTheScreen();
      });
      await fireEvent.press(screen.getByText(roleCopy.choiceMaster));

      expect(mockPush).toHaveBeenCalledWith('/(shared)/become-master');
      expect(requests.some((r) => r.method === 'POST' && r.pathname === '/customers')).toBe(false);
    });

    it('goes straight to the name for an account that already holds a role', async () => {
      replies[routeKey('GET', '/customers/me')] = { status: 404, body: {} };
      await mount(['master']);

      await waitFor(() => {
        expect(screen.getByText(copy.setupTitle)).toBeOnTheScreen();
      });
      expect(screen.queryByText(roleCopy.choiceTitle)).not.toBeOnTheScreen();
    });
  });
});
