import { createAppStore } from './index';
import {
  otpRequested,
  roleSelected,
  selectAuthStatus,
  selectCanSwitchRole,
  selectGrantedRoles,
  selectOtpRequestedFor,
  selectRole,
  selectUserId,
  signedIn,
  signedOut,
} from './session-slice';

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

describe('session status', () => {
  it('starts out restoring, not signed out', () => {
    const store = createAppStore();

    // The app has a refresh token in the keychain or it does not, and nobody
    // knows which until it has been traded. Starting in `signed-out` would
    // flash the sign-in screen at every returning user.
    expect(selectAuthStatus(store.getState())).toBe('restoring');
  });

  it('holds the identity a verified token carried', () => {
    const store = createAppStore();

    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));

    expect(selectAuthStatus(store.getState())).toBe('signed-in');
    expect(selectUserId(store.getState())).toBe('user-1');
    expect(selectGrantedRoles(store.getState())).toEqual(['customer']);
  });

  it('snaps the selected role onto a granted one', () => {
    const store = createAppStore();
    store.dispatch(roleSelected('master'));

    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));

    // A stale preference from a previous session must not open the app into a
    // group the guard will immediately redirect out of.
    expect(selectRole(store.getState())).toBe('customer');
  });

  it('leaves a granted selection alone', () => {
    const store = createAppStore();
    store.dispatch(roleSelected('master'));

    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer', 'master'] }));

    expect(selectRole(store.getState())).toBe('master');
  });

  it('leaves the selection alone when the token said nothing about roles', () => {
    const store = createAppStore();
    store.dispatch(roleSelected('master'));

    store.dispatch(signedIn({ userId: null, roles: [] }));

    expect(selectRole(store.getState())).toBe('master');
  });

  it('drops everything about the previous user on sign-out', () => {
    const store = createAppStore();
    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer', 'master'] }));
    store.dispatch(roleSelected('master'));

    store.dispatch(signedOut());

    // An app that keeps the last user's id or grants around is one bug away
    // from showing them to the next person who signs in on the same device.
    expect(selectAuthStatus(store.getState())).toBe('signed-out');
    expect(selectUserId(store.getState())).toBeNull();
    expect(selectGrantedRoles(store.getState())).toEqual([]);
    expect(selectRole(store.getState())).toBe('customer');
  });
});

describe('role switching', () => {
  it('is offered only to a user holding both roles', () => {
    const store = createAppStore();

    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));
    expect(selectCanSwitchRole(store.getState())).toBe(false);

    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer', 'master'] }));
    expect(selectCanSwitchRole(store.getState())).toBe(true);
  });

  it('is not offered when the token could not be read', () => {
    const store = createAppStore();

    store.dispatch(signedIn({ userId: null, roles: [] }));

    expect(selectCanSwitchRole(store.getState())).toBe(false);
  });
});

describe('the pending OTP number', () => {
  it('is remembered between the two sign-in screens', () => {
    const store = createAppStore();

    store.dispatch(otpRequested('+994501234567'));

    expect(selectOtpRequestedFor(store.getState())).toBe('+994501234567');
  });

  it('is dropped once the session starts', () => {
    const store = createAppStore();
    store.dispatch(otpRequested('+994501234567'));

    store.dispatch(signedIn({ userId: 'user-1', roles: ['customer'] }));

    expect(selectOtpRequestedFor(store.getState())).toBeNull();
  });

  it('is dropped on sign-out', () => {
    const store = createAppStore();
    store.dispatch(otpRequested('+994501234567'));

    store.dispatch(signedOut());

    expect(selectOtpRequestedFor(store.getState())).toBeNull();
  });
});
