import { createTestStore } from '../../test/support/test-store';
import { fixtureCall } from './call-fixtures';
import {
  callSurfaceLive,
  ringingCallCleared,
  ringingCallReceived,
  selectCallSurfaceLive,
  selectRingingCall,
} from './ringing-call-slice';

describe('the ringing call', () => {
  it('starts with nothing ringing and no call on screen', () => {
    const store = createTestStore();

    expect(selectRingingCall(store.getState())).toBeNull();
    expect(selectCallSurfaceLive(store.getState())).toBe(false);
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

  it('records whether a call screen holds a live call', () => {
    const store = createTestStore();

    store.dispatch(callSurfaceLive(true));
    expect(selectCallSurfaceLive(store.getState())).toBe(true);

    store.dispatch(callSurfaceLive(false));
    expect(selectCallSurfaceLive(store.getState())).toBe(false);
  });
});
