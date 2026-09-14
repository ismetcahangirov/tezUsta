import { useSessionStore } from './session';

describe('session store', () => {
  beforeEach(() => {
    useSessionStore.setState({ role: 'customer' });
  });

  it('starts in the customer role', () => {
    expect(useSessionStore.getState().role).toBe('customer');
  });

  it('switches to the master role', () => {
    useSessionStore.getState().setRole('master');

    expect(useSessionStore.getState().role).toBe('master');
  });
});
