import { createTestStore } from '../../test/support/test-store';
import { fixtureCall } from './call-fixtures';
import {
  callSurfaceClosed,
  callSurfaceShown,
  ringingCallCleared,
  ringingCallReceived,
  selectCallSurfaceLive,
  selectCallSurfaceOpen,
  selectRingingCall,
} from './ringing-call-slice';

describe('the ringing call', () => {
  it('starts with nothing ringing and no call on screen', () => {
    const store = createTestStore();

    expect(selectRingingCall(store.getState())).toBeNull();
    expect(selectCallSurfaceLive(store.getState())).toBe(false);
    expect(selectCallSurfaceOpen(store.getState())).toBe(false);
  });

  it('holds the ringing call as the server described it', () => {
    const store = createTestStore();
    const ringing = fixtureCall('RINGING');

    store.dispatch(ringingCallReceived(ringing));

    expect(selectRingingCall(store.getState())).toEqual(ringing);
  });

  it('is cleared by its own call ending, and not by another call’s', () => {
    const store = createTestStore();
    store.dispatch(ringingCallReceived(fixtureCall('RINGING', { id: 'call-2' })));

    store.dispatch(ringingCallCleared('call-1'));
    expect(selectRingingCall(store.getState())?.id).toBe('call-2');

    store.dispatch(ringingCallCleared('call-2'));
    expect(selectRingingCall(store.getState())).toBeNull();
  });
});

describe('the call screen on record', () => {
  it('records a live call, then an ended one, then none', () => {
    const store = createTestStore();

    store.dispatch(callSurfaceShown({ token: 'a', live: true }));
    expect(selectCallSurfaceLive(store.getState())).toBe(true);

    store.dispatch(callSurfaceShown({ token: 'a', live: false }));
    expect(selectCallSurfaceLive(store.getState())).toBe(false);
    expect(selectCallSurfaceOpen(store.getState())).toBe(true);

    store.dispatch(callSurfaceClosed('a'));
    expect(selectCallSurfaceOpen(store.getState())).toBe(false);
  });

  it('cannot be cleared by an older screen closing under a newer one', () => {
    const store = createTestStore();
    store.dispatch(callSurfaceShown({ token: 'old', live: false }));
    store.dispatch(callSurfaceShown({ token: 'new', live: true }));

    store.dispatch(callSurfaceClosed('old'));

    expect(selectCallSurfaceLive(store.getState())).toBe(true);
  });
});
