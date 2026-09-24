import { foregroundPresentationFor, isRingFor, readCallId } from './call-notification';

const RING = { kind: 'call-incoming', orderId: 'order-1', callId: 'call-1' };

describe('foregroundPresentationFor', () => {
  it('silences a ring push while calling is on — the app rings in-app instead', () => {
    expect(foregroundPresentationFor(RING, true)).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });

  it('shows a ring push as before while calling ships dark', () => {
    expect(foregroundPresentationFor(RING, false)).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    });
  });

  it.each([
    ['an order notification', { kind: 'order-accepted', orderId: 'order-1' }],
    ['a message', { kind: 'message-received', orderId: 'order-1' }],
    ['no data at all', undefined],
    ['a string', 'call-incoming'],
  ])('shows %s, calling on or off', (_what, data) => {
    expect(foregroundPresentationFor(data, true).shouldShowBanner).toBe(true);
    expect(foregroundPresentationFor(data, true).shouldPlaySound).toBe(true);
  });
});

describe('isRingFor', () => {
  it('matches a ring push for exactly this call', () => {
    expect(isRingFor(RING, 'call-1')).toBe(true);
  });

  it.each([
    ['another call', RING, 'call-2'],
    ['a message about the same id', { kind: 'message-received', callId: 'call-1' }, 'call-1'],
    ['no data', null, 'call-1'],
  ])('does not match %s', (_what, data, callId) => {
    expect(isRingFor(data, callId)).toBe(false);
  });
});

describe('readCallId', () => {
  it('reads an id-shaped string', () => {
    expect(readCallId('3f2b8a3c-1d4e-4c9a-9f0e-2b6c7d8e9f01')).toBe(
      '3f2b8a3c-1d4e-4c9a-9f0e-2b6c7d8e9f01',
    );
  });

  it.each([undefined, null, 7, '', '../x', 'a/b', 'a?b', 'a b', 'a'.repeat(65)])(
    'refuses %p',
    (value) => {
      expect(readCallId(value)).toBeNull();
    },
  );
});
