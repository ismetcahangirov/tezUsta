import type { Order } from '@tezusta/types';
import { Stack } from 'expo-router';
import { userEvent } from '@testing-library/react-native';
import { renderRouter, screen } from 'expo-router/testing-library';
import { Provider } from 'react-redux';

import OrderMasterScreen from '../../app/(customer)/order/[id]/master';
import OrderScreen from '../../app/(customer)/order/[id]/index';
import { createTestStore } from '../../test/support/test-store';
import { ORDERS_COPY } from '../orders/orders-copy';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';
import { PROFILE } from './portfolio-fixtures';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const ORDER_ID = 'order-1';
const MASTER_ID = 'master-1';

/** At work: past the map's statuses (ADR-0035), with a master and a conversation. */
const ORDER = {
  id: ORDER_ID,
  status: 'IN_PROGRESS',
  serviceId: 'svc-1',
  addressId: 'addr-1',
  description: 'Mətbəxdə kran sızır.',
  priceMinor: 2500,
  masterId: MASTER_ID,
  redispatchCount: 0,
  acceptedAt: '2026-10-16T08:00:00.000Z',
  createdAt: '2026-10-16T07:00:00.000Z',
  updatedAt: '2026-10-16T08:00:00.000Z',
  unreadMessageCount: 0,
} as unknown as Order;

const requested: string[] = [];

function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const { pathname } = new URL(request.url);
    requested.push(pathname);
    const body: unknown =
      pathname === `/orders/${ORDER_ID}`
        ? ORDER
        : pathname === `/masters/${MASTER_ID}/profile`
          ? { ...PROFILE, masterId: MASTER_ID }
          : // The order screen's other reads (photos, addresses, reviews,
            // reports) are lists, or answer with nothing to show.
            [];
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

describe('the master profile, from the order', () => {
  it('opens from the order screen and goes back to it as it was', async () => {
    installTransport();
    const store = createTestStore();

    const rendered = renderRouter(
      {
        _layout: () => <Stack screenOptions={{ headerShown: false }} />,
        '(customer)/order/[id]/index': OrderScreen,
        '(customer)/order/[id]/master': OrderMasterScreen,
      },
      {
        initialUrl: `/order/${ORDER_ID}`,
        wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
      },
    );
    const getPathname = (): string => rendered.getPathname();
    await (rendered as unknown as Promise<unknown>);

    const row = await screen.findByRole('button', {
      name: `${PROFILE.displayName}, ${copy.profile.entrySubtitle}`,
    });
    await userEvent.press(row);

    expect(getPathname()).toBe(`/order/${ORDER_ID}/master`);
    const orderReads = requested.filter((path) => path === `/orders/${ORDER_ID}`).length;
    expect(await screen.findByRole('header', { name: copy.profile.worksTitle })).toBeOnTheScreen();

    const backs = screen.getAllByRole('button', { name: copy.profile.back });
    await userEvent.press(backs[0]!);

    expect(getPathname()).toBe(`/order/${ORDER_ID}`);
    expect(await screen.findByText(ORDERS_COPY.detail.title)).toBeOnTheScreen();
    // The order screen was kept under the profile, not mounted again: it
    // reads its order no more often than before the profile was opened.
    expect(requested.filter((path) => path === `/orders/${ORDER_ID}`)).toHaveLength(orderReads);
    // The row is back where it was, from the same cached profile.
    expect(
      screen.getByRole('button', { name: `${PROFILE.displayName}, ${copy.profile.entrySubtitle}` }),
    ).toBeOnTheScreen();
  });
});
