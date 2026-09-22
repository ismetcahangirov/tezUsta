import { registeredDevice } from './registered-device';

describe('registeredDevice', () => {
  afterEach(() => {
    registeredDevice.forget();
  });

  it('holds nothing until a registration succeeds', () => {
    expect(registeredDevice.current()).toBeNull();
  });

  it('remembers the id and the token the server accepted', () => {
    registeredDevice.remember({ id: 'device-1', expoPushToken: 'ExponentPushToken[aaa]' });

    expect(registeredDevice.current()).toEqual({
      id: 'device-1',
      expoPushToken: 'ExponentPushToken[aaa]',
    });
  });

  it('replaces the previous registration rather than accumulating them', () => {
    registeredDevice.remember({ id: 'device-1', expoPushToken: 'ExponentPushToken[aaa]' });
    registeredDevice.remember({ id: 'device-2', expoPushToken: 'ExponentPushToken[bbb]' });

    expect(registeredDevice.current()).toEqual({
      id: 'device-2',
      expoPushToken: 'ExponentPushToken[bbb]',
    });
  });

  it('forgets the registration, so the next user on this phone inherits nothing', () => {
    registeredDevice.remember({ id: 'device-1', expoPushToken: 'ExponentPushToken[aaa]' });

    registeredDevice.forget();

    expect(registeredDevice.current()).toBeNull();
  });
});
