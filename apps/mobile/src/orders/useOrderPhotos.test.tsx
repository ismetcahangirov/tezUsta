import { act, renderHook, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { useOrderPhotos } from './useOrderPhotos';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/** What the iPhone camera saves by default, handed over raw by the picker. */
const MOCK_HEIC = {
  uri: 'file:///DCIM/IMG_0001.HEIC',
  mimeType: 'image/heic',
  width: 4032,
  height: 3024,
};
const MOCK_CONVERTED = 'file:///cache/ImageManipulator/converted.jpg';
const UPLOAD_URL = 'https://storage.test/order-photos/abc?signature=x';

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  launchImageLibraryAsync: jest.fn(() => Promise.resolve({ canceled: false, assets: [MOCK_HEIC] })),
}));

/** What the manipulator was asked to open: the picked file, then the decoded image. */
const mockManipulated: unknown[] = [];
let mockDecodeFails = false;

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  ImageManipulator: {
    manipulate: (source: unknown) => {
      mockManipulated.push(source);
      const context = {
        resize: () => context,
        release: () => undefined,
        renderAsync: () =>
          mockDecodeFails
            ? Promise.reject(new Error('cannot decode'))
            : Promise.resolve({
                width: 4032,
                height: 3024,
                saveAsync: () =>
                  Promise.resolve({ uri: MOCK_CONVERTED, width: 2560, height: 1920 }),
                release: () => undefined,
              }),
      };
      return context;
    },
  },
}));

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly contentType: string | null;
  readonly body: unknown;
}

let sent: Sent[] = [];

function installTransport(): void {
  global.fetch = (async (input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    const url = new URL(request.url);
    const text = request.method === 'GET' || url.href === UPLOAD_URL ? '' : await request.text();
    sent.push({
      method: request.method,
      url: url.href,
      contentType: request.headers.get('content-type'),
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    });

    if (url.protocol === 'file:') {
      // The local file the hook reads its bytes from.
      return new Response('jpeg-bytes', { status: 200 });
    }
    if (url.href === UPLOAD_URL) {
      return new Response(null, { status: 200 });
    }
    if (url.pathname === '/orders/photos/presign') {
      return Response.json({
        photoId: 'photo-1',
        uploadUrl: UPLOAD_URL,
        expiresAt: '2026-10-14T10:05:00.000Z',
        contentType: 'image/jpeg',
        maxBytes: 10_000_000,
      });
    }
    if (url.pathname === '/orders/photos/photo-1/confirm') {
      return Response.json({ id: 'photo-1' });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Provider store={createTestStore()}>{children}</Provider>;
}

beforeEach(() => {
  sent = [];
  mockManipulated.length = 0;
  mockDecodeFails = false;
  installTransport();
});

/** #319: an iPhone photo reaches storage as a JPEG. */
describe('useOrderPhotos', () => {
  it('converts a HEIC pick, then uploads the converted file as image/jpeg', async () => {
    const { result } = await renderHook(() => useOrderPhotos(5), { wrapper });

    await act(async () => {
      await result.current.pick();
    });

    await waitFor(() => {
      expect(result.current.photos[0]?.status).toBe('ready');
    });
    expect(mockManipulated[0]).toBe(MOCK_HEIC.uri);

    const presign = sent.find((request) => request.url.endsWith('/orders/photos/presign'));
    expect(presign?.body).toEqual({ contentType: 'image/jpeg' });

    // The bytes are the converted file's, never the original MOCK_HEIC's.
    expect(sent.some((request) => request.url === MOCK_CONVERTED)).toBe(true);
    expect(sent.some((request) => request.url === MOCK_HEIC.uri)).toBe(false);

    const put = sent.find((request) => request.url === UPLOAD_URL);
    expect(put).toMatchObject({ method: 'PUT', contentType: 'image/jpeg' });
    expect(result.current.readyPhotoIds()).toEqual(['photo-1']);
  });

  it('marks a photo the device cannot decode as failed, without asking the server', async () => {
    mockDecodeFails = true;
    const { result } = await renderHook(() => useOrderPhotos(5), { wrapper });

    await act(async () => {
      await result.current.pick();
    });

    await waitFor(() => {
      expect(result.current.photos[0]?.status).toBe('failed');
    });
    expect(sent).toEqual([]);
    expect(result.current.readyPhotoIds()).toEqual([]);
  });
});
