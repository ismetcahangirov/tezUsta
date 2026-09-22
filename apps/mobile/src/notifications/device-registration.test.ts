import type { Device, DeviceRegistration } from '@tezusta/types';

import { registerPushDevice } from './device-registration';
import type { PushPlatform } from './device-registration';
import type { PushPermission } from './push-permission';

const DEVICE: Device = {
  id: 'f1f0f6b2-0d3a-4a1e-8c2e-9b0e1f2a3b4c',
  platform: 'android',
  tokenSuffix: 'abc123',
  deviceId: 'Pixel 7',
  appVersion: '0.1.0',
  createdAt: '2026-09-22T09:00:00.000Z',
  updatedAt: '2026-09-22T09:00:00.000Z',
  lastSeenAt: '2026-09-22T09:00:00.000Z',
};

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

/**
 * Records the order calls arrive in, because one of the requirements here is
 * an ordering rather than an outcome.
 */
function makePlatform(
  overrides: Partial<PushPlatform> = {},
  calls: string[] = [],
): { platform: PushPlatform; calls: string[] } {
  const platform: PushPlatform = {
    isSupported: true,
    ensureChannels: jest.fn(() => {
      calls.push('ensureChannels');
      return Promise.resolve();
    }),
    getPermission: jest.fn((): Promise<PushPermission> => {
      calls.push('getPermission');
      return Promise.resolve('granted');
    }),
    requestPermission: jest.fn((): Promise<PushPermission> => {
      calls.push('requestPermission');
      return Promise.resolve('granted');
    }),
    acquireToken: jest.fn(() => {
      calls.push('acquireToken');
      return Promise.resolve(TOKEN);
    }),
    describeDevice: () => ({ platform: 'android', deviceId: 'Pixel 7', appVersion: '0.1.0' }),
    ...overrides,
  };

  return { platform, calls };
}

describe('registerPushDevice', () => {
  it('registers the device when permission is already granted', async () => {
    const { platform } = makePlatform();
    const register = jest.fn(() => Promise.resolve(DEVICE));

    const outcome = await registerPushDevice(platform, register, { mayAsk: false });

    expect(outcome).toEqual({ status: 'registered', device: DEVICE, expoPushToken: TOKEN });
    expect(register).toHaveBeenCalledWith<[DeviceRegistration]>({
      expoPushToken: TOKEN,
      platform: 'android',
      deviceId: 'Pixel 7',
      appVersion: '0.1.0',
    });
  });

  it('creates the notification channels before it asks for a token', async () => {
    // Not cosmetic ordering. On Android 13 the system permission prompt does
    // not appear until at least one channel exists, and Expo documents
    // `setNotificationChannelAsync` as having to run before the token call.
    const { platform, calls } = makePlatform();

    await registerPushDevice(platform, () => Promise.resolve(DEVICE), { mayAsk: true });

    expect(calls.indexOf('ensureChannels')).toBeLessThan(calls.indexOf('acquireToken'));
    expect(calls.indexOf('ensureChannels')).toBeLessThan(calls.indexOf('getPermission'));
  });

  it('does nothing at all where push is unsupported', async () => {
    // Expo Go on Android throws rather than warning from SDK 55, so the guard
    // has to come before the first vendor call, not after it.
    const { platform, calls } = makePlatform({ isSupported: false });
    const register = jest.fn(() => Promise.resolve(DEVICE));

    const outcome = await registerPushDevice(platform, register, { mayAsk: true });

    expect(outcome).toEqual({ status: 'unsupported' });
    expect(calls).toEqual([]);
    expect(register).not.toHaveBeenCalled();
  });

  it('leaves an unasked permission alone when it is not the moment to ask', async () => {
    const { platform } = makePlatform({
      getPermission: jest.fn((): Promise<PushPermission> => Promise.resolve('askable')),
    });
    const register = jest.fn(() => Promise.resolve(DEVICE));

    const outcome = await registerPushDevice(platform, register, { mayAsk: false });

    expect(outcome).toEqual({ status: 'not-permitted', permission: 'askable' });
    expect(platform.requestPermission).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('asks once, and registers when the user agrees', async () => {
    const { platform } = makePlatform({
      getPermission: jest.fn((): Promise<PushPermission> => Promise.resolve('askable')),
    });

    const outcome = await registerPushDevice(platform, () => Promise.resolve(DEVICE), {
      mayAsk: true,
    });

    expect(outcome).toEqual({ status: 'registered', device: DEVICE, expoPushToken: TOKEN });
    expect(platform.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('stops at the refusal when the user says no', async () => {
    const { platform } = makePlatform({
      getPermission: jest.fn((): Promise<PushPermission> => Promise.resolve('askable')),
      requestPermission: jest.fn((): Promise<PushPermission> => Promise.resolve('blocked')),
    });
    const register = jest.fn(() => Promise.resolve(DEVICE));

    const outcome = await registerPushDevice(platform, register, { mayAsk: true });

    expect(outcome).toEqual({ status: 'not-permitted', permission: 'blocked' });
    expect(platform.acquireToken).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('never prompts a user who has already refused', async () => {
    // A dialog loop is the failure this test exists to prevent.
    const { platform } = makePlatform({
      getPermission: jest.fn((): Promise<PushPermission> => Promise.resolve('blocked')),
    });

    const outcome = await registerPushDevice(platform, () => Promise.resolve(DEVICE), {
      mayAsk: true,
    });

    expect(outcome).toEqual({ status: 'not-permitted', permission: 'blocked' });
    expect(platform.requestPermission).not.toHaveBeenCalled();
  });

  it('reports a token that could not be acquired without posting anything', async () => {
    // Permission granted and no token is a real, separate state: no network,
    // or no EAS project id configured for the build.
    const { platform } = makePlatform({
      acquireToken: jest.fn(() => Promise.reject(new Error('ERR_NOTIFICATIONS_NO_EXPERIENCE_ID'))),
    });
    const register = jest.fn(() => Promise.resolve(DEVICE));

    const outcome = await registerPushDevice(platform, register, { mayAsk: false });

    expect(outcome).toEqual({ status: 'token-unavailable' });
    expect(register).not.toHaveBeenCalled();
  });

  it('reports a failed registration rather than throwing at the caller', async () => {
    const { platform } = makePlatform();

    const outcome = await registerPushDevice(platform, () => Promise.reject(new Error('503')), {
      mayAsk: false,
    });

    expect(outcome).toEqual({ status: 'registration-failed' });
  });

  it('omits the optional fields the platform could not describe', async () => {
    const { platform } = makePlatform({
      describeDevice: () => ({ platform: 'ios', deviceId: undefined, appVersion: undefined }),
    });
    const register = jest.fn(() => Promise.resolve(DEVICE));

    await registerPushDevice(platform, register, { mayAsk: false });

    expect(register).toHaveBeenCalledWith<[DeviceRegistration]>({
      expoPushToken: TOKEN,
      platform: 'ios',
    });
  });
});
