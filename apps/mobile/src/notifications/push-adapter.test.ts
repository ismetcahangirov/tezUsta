/**
 * The vendor edge of the ring push (#189): what the foreground handler answers
 * and which presented notifications a dismissal touches. `expo-notifications`
 * is replaced with a recording stand-in; this file is the only one allowed to
 * know what that module's calls look like.
 */

import { configureForegroundPresentation, dismissCallNotifications } from './push-adapter';

interface Presentation {
  readonly shouldShowBanner: boolean;
  readonly shouldPlaySound: boolean;
}

interface Handler {
  handleNotification: (notification: {
    request: { content: { data: unknown } };
  }) => Promise<Presentation>;
}

interface Presented {
  readonly request: { readonly identifier: string; readonly content: { readonly data: unknown } };
}

interface MockNotifications {
  handler: Handler | null;
  presented: Presented[];
  dismissed: string[];
  setNotificationHandler: (handler: Handler) => void;
  getPresentedNotificationsAsync: () => Promise<Presented[]>;
  dismissNotificationAsync: (identifier: string) => Promise<void>;
}

// `jest.mock` factories are hoisted above the import; the `mock` prefix is
// what lets them read this object.
const mockModule: MockNotifications = {
  handler: null,
  presented: [],
  dismissed: [],
  setNotificationHandler: (handler) => {
    mockModule.handler = handler;
  },
  getPresentedNotificationsAsync: () => Promise.resolve(mockModule.presented),
  dismissNotificationAsync: (identifier) => {
    mockModule.dismissed.push(identifier);
    return Promise.resolve();
  },
};

jest.mock('expo-notifications', () => mockModule);
jest.mock('expo', () => ({ isRunningInExpoGo: () => false }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { deviceName: 'test' } }));

let mockCallingEnabled = true;
jest.mock('../calls/calling-enabled', () => ({
  get CALLING_ENABLED() {
    return mockCallingEnabled;
  },
}));

function arriving(data: unknown) {
  return { request: { content: { data } } };
}

beforeEach(() => {
  mockModule.getPresentedNotificationsAsync = () => Promise.resolve(mockModule.presented);
  mockModule.handler = null;
  mockModule.presented = [];
  mockModule.dismissed = [];
  mockCallingEnabled = true;
});

describe('the foreground handler', () => {
  it('shows neither a banner nor a sound for a ring push, which rings in-app', async () => {
    configureForegroundPresentation();

    const answer = await mockModule.handler?.handleNotification(
      arriving({ kind: 'call-incoming', orderId: 'order-1', callId: 'call-1' }),
    );

    expect(answer).toMatchObject({ shouldShowBanner: false, shouldPlaySound: false });
  });

  it('shows everything else as it always did', async () => {
    configureForegroundPresentation();

    const answer = await mockModule.handler?.handleNotification(
      arriving({ kind: 'order-accepted', orderId: 'order-1' }),
    );

    expect(answer).toMatchObject({ shouldShowBanner: true, shouldPlaySound: true });
  });

  it('shows a ring push while calling ships dark', async () => {
    mockCallingEnabled = false;
    configureForegroundPresentation();

    const answer = await mockModule.handler?.handleNotification(
      arriving({ kind: 'call-incoming', orderId: 'order-1', callId: 'call-1' }),
    );

    expect(answer).toMatchObject({ shouldShowBanner: true, shouldPlaySound: true });
  });
});

describe('dismissCallNotifications', () => {
  it('takes down the ring for that call and nothing else', async () => {
    mockModule.presented = [
      {
        request: {
          identifier: 'n-1',
          content: { data: { kind: 'call-incoming', callId: 'call-1' } },
        },
      },
      {
        request: {
          identifier: 'n-2',
          content: { data: { kind: 'call-incoming', callId: 'call-2' } },
        },
      },
      {
        request: { identifier: 'n-3', content: { data: { kind: 'order-accepted', orderId: 'o' } } },
      },
    ];

    await dismissCallNotifications('call-1');

    expect(mockModule.dismissed).toEqual(['n-1']);
  });

  it('does not throw when the platform refuses', async () => {
    mockModule.getPresentedNotificationsAsync = () => Promise.reject(new Error('no'));

    await expect(dismissCallNotifications('call-1')).resolves.toBeUndefined();
  });
});
