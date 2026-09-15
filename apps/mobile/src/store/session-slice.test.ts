import { createAppStore } from './index';
import { roleSelected, selectRole } from './session-slice';

describe('session role', () => {
  it('starts in the customer role', () => {
    const store = createAppStore();

    expect(selectRole(store.getState())).toBe('customer');
  });

  it('switches to the master role', () => {
    const store = createAppStore();

    store.dispatch(roleSelected('master'));

    expect(selectRole(store.getState())).toBe('master');
  });

  it('switches back', () => {
    const store = createAppStore();

    store.dispatch(roleSelected('master'));
    store.dispatch(roleSelected('customer'));

    expect(selectRole(store.getState())).toBe('customer');
  });

  it('gives each store its own state, so one test cannot leak into the next', () => {
    const first = createAppStore();
    const second = createAppStore();

    first.dispatch(roleSelected('master'));

    expect(selectRole(first.getState())).toBe('master');
    expect(selectRole(second.getState())).toBe('customer');
  });
});
