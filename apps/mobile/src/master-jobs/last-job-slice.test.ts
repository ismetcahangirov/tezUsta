import { createTestStore } from '../../test/support/test-store';
import { signedIn, signedOut } from '../store/session-slice';
import { jobSeen, selectLastJobOrderId } from './last-job-slice';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

describe('last-job-slice', () => {
  it('remembers nothing until a job is seen, then the most recent one', () => {
    const store = createTestStore();
    expect(selectLastJobOrderId(store.getState())).toBeNull();

    store.dispatch(jobSeen('order-1'));
    store.dispatch(jobSeen('order-2'));

    expect(selectLastJobOrderId(store.getState())).toBe('order-2');
  });

  it('forgets the job at sign-out, so the next account on this phone is not asked about it', () => {
    const store = createTestStore();
    store.dispatch(signedIn({ userId: 'user-1', roles: ['master'] }));
    store.dispatch(jobSeen('order-1'));

    store.dispatch(signedOut());

    expect(selectLastJobOrderId(store.getState())).toBeNull();
  });
});
