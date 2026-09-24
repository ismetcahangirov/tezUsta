import { fireEvent, render, screen } from '@testing-library/react-native';

import { CALL_COPY as copy } from './call-copy';
import { CallEntry } from './CallEntry';

const mockPush = jest.fn();
let mockCallingEnabled = true;

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// A getter, so each test can decide whether this build ships calling.
jest.mock('./calling-enabled', () => ({
  get CALLING_ENABLED() {
    return mockCallingEnabled;
  },
}));

beforeEach(() => {
  mockPush.mockReset();
  mockCallingEnabled = true;
});

describe('CallEntry', () => {
  it('renders nothing while calling ships dark, even on a callable order', async () => {
    mockCallingEnabled = false;

    await render(<CallEntry orderId="order-1" viewer="customer" available />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing once the order can no longer be called about', async () => {
    await render(<CallEntry orderId="order-1" viewer="customer" available={false} />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('names the other party, for each side of the order', async () => {
    await render(
      <>
        <CallEntry orderId="order-1" viewer="customer" available />
        <CallEntry orderId="order-1" viewer="master" available />
      </>,
    );

    expect(screen.getByRole('button', { name: copy.entry.customer })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: copy.entry.master })).toBeOnTheScreen();
  });

  it('opens the outgoing call for this order', async () => {
    await render(<CallEntry orderId="order-7" viewer="master" available />);

    await fireEvent.press(screen.getByRole('button', { name: copy.entry.master }));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/call/outgoing/[orderId]',
      params: { orderId: 'order-7' },
    });
  });
});
