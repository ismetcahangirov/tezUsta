import type { MasterPublicProfile } from '@tezusta/types';
import { render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { MasterProfileEntry } from './MasterProfileEntry';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';
import { PROFILE } from './portfolio-fixtures';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const MASTER_ID = 'master-1';
const ROW = `${PROFILE.displayName}, ${copy.profile.entrySubtitle}`;

let reply: { status: number; body: unknown } = { status: 200, body: {} };
let requested: string[] = [];

async function mount(masterId: string | null, onPress = jest.fn()): Promise<jest.Mock> {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    requested.push(new URL(request.url).pathname);
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;

  await render(
    <Provider store={createTestStore()}>
      <MasterProfileEntry masterId={masterId} onPress={onPress} />
    </Provider>,
  );
  return onPress;
}

beforeEach(() => {
  requested = [];
});

describe('MasterProfileEntry', () => {
  it('shows the master once their profile has been read, and opens it', async () => {
    reply = {
      status: 200,
      body: { ...PROFILE, masterId: MASTER_ID } satisfies MasterPublicProfile,
    };
    const onPress = await mount(MASTER_ID);

    await userEvent.press(await screen.findByRole('button', { name: ROW }));

    expect(screen.getByText(copy.profile.entrySubtitle)).toBeOnTheScreen();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('draws nothing when the server will not show the profile', async () => {
    reply = { status: 404, body: { code: 'NOT_FOUND' } };
    await mount(MASTER_ID);

    await waitFor(() => {
      expect(requested).toContain(`/masters/${MASTER_ID}/profile`);
    });
    expect(screen.queryByRole('button', { name: ROW })).not.toBeOnTheScreen();
    expect(screen.queryByText(copy.profile.entrySubtitle)).not.toBeOnTheScreen();
  });

  it('asks for nothing while the order has no master', async () => {
    await mount(null);

    expect(requested).toEqual([]);
    expect(screen.queryByText(copy.profile.entrySubtitle)).not.toBeOnTheScreen();
  });
});
