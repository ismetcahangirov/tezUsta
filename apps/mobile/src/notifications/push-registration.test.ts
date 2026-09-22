import type { Device } from '@tezusta/types';

import type { PushPlatform } from './device-registration';
import { retireRegisteredDevice, runPushRegistration } from './push-registration';
import { registeredDevice } from './registered-device';

/**
 * The adapter is the vendor boundary, and substituting it is the point of
 * having one: nothing below this line touches a native module.
 *
 * Read through a getter so the platform can be swapped per test —
 * `runPushRegistration` reads `expoPushPlatform` when it runs, not when it is
 * imported. The `mock` prefix is what lets the hoisted factory reference it.
 */
const mockPlatform: { current: PushPlatform } = {
  current: {
    isSupported: true,
    ensureChannels: jest.fn(() => Promise.resolve()),
    getPermission: jest.fn(() => Promise.resolve('granted' as const)),
    requestPermission: jest.fn(() => Promise.resolve('granted' as const)),
    acquireToken: jest.fn(() => Promise.resolve('ExponentPushToken[aaa]')),
    describeDevice: () => ({ platform: 'android', deviceId: undefined, appVersion: undefined }),
  },
};

jest.mock('./push-adapter', () => ({
  get expoPushPlatform() {
    return mockPlatform.current;
  },
}));

function deviceNamed(id: string): Device {
  return {
    id,
    platform: 'android',
    tokenSuffix: 'aaa',
    deviceId: null,
    appVersion: null,
    createdAt: '2026-09-22T09:00:00.000Z',
    updatedAt: '2026-09-22T09:00:00.000Z',
    lastSeenAt: '2026-09-22T09:00:00.000Z',
  };
}

describe('runPushRegistration', () => {
  afterEach(() => {
    registeredDevice.forget();
  });

  it('remembers the device the server acknowledged, so sign-out can retire it', async () => {
    await runPushRegistration(() => Promise.resolve(deviceNamed('device-1')), { mayAsk: false });

    expect(registeredDevice.current()).toEqual({
      id: 'device-1',
      expoPushToken: 'ExponentPushToken[aaa]',
    });
  });

  it('remembers nothing when registration did not happen', async () => {
    mockPlatform.current = { ...mockPlatform.current, isSupported: false };

    const outcome = await runPushRegistration(() => Promise.resolve(deviceNamed('device-1')), {
      mayAsk: false,
    });

    expect(outcome).toEqual({ status: 'unsupported' });
    expect(registeredDevice.current()).toBeNull();

    mockPlatform.current = { ...mockPlatform.current, isSupported: true };
  });

  it('runs one registration at a time, so two starts do not race one token', async () => {
    const order: string[] = [];
    const register = jest.fn(async (): Promise<Device> => {
      order.push('start');
      await Promise.resolve();
      order.push('end');
      return deviceNamed('device-1');
    });

    await Promise.all([
      runPushRegistration(register, { mayAsk: false }),
      runPushRegistration(register, { mayAsk: false }),
    ]);

    expect(order).toEqual(['start', 'end', 'start', 'end']);
  });

  it('gives a queued caller its own answer rather than the one in front of it', async () => {
    // A launch pass must not swallow the prompt a call site earned.
    const failing = (): Promise<Device> => Promise.reject(new Error('503'));

    const [first, second] = await Promise.all([
      runPushRegistration(failing, { mayAsk: false }),
      runPushRegistration(() => Promise.resolve(deviceNamed('device-2')), { mayAsk: false }),
    ]);

    expect(first).toEqual({ status: 'registration-failed' });
    expect(second).toEqual({
      status: 'registered',
      device: deviceNamed('device-2'),
      expoPushToken: 'ExponentPushToken[aaa]',
    });
  });
});

describe('retireRegisteredDevice', () => {
  afterEach(() => {
    registeredDevice.forget();
  });

  it('retires the registered row and forgets it', async () => {
    registeredDevice.remember({ id: 'device-1', expoPushToken: 'ExponentPushToken[aaa]' });
    const retire = jest.fn(() => Promise.resolve());

    await retireRegisteredDevice(retire);

    expect(retire).toHaveBeenCalledWith('device-1');
    expect(registeredDevice.current()).toBeNull();
  });

  it('does nothing when this installation never registered', async () => {
    const retire = jest.fn(() => Promise.resolve());

    await retireRegisteredDevice(retire);

    expect(retire).not.toHaveBeenCalled();
  });

  it('forgets the device even when the server could not be reached', async () => {
    // Sign-out must not be held up by a network failure, and keeping the id
    // would let the next user on this phone retire a row that is not theirs.
    registeredDevice.remember({ id: 'device-1', expoPushToken: 'ExponentPushToken[aaa]' });

    await expect(
      retireRegisteredDevice(() => Promise.reject(new Error('offline'))),
    ).resolves.toBeUndefined();

    expect(registeredDevice.current()).toBeNull();
  });
});
