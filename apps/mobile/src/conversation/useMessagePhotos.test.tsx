import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { Provider } from 'react-redux';

import { FAKE_CACHE_URI, fakeFiles } from '../../test/support/fake-file-system';
import { createTestStore } from '../../test/support/test-store';
import { MAX_PHOTOS_PER_MESSAGE } from './conversation-endpoints';
import { useMessagePhotos } from './useMessagePhotos';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/** The picker's copies, inside the app's cache, as Android and iOS return them. */
const PICKED = [`${FAKE_CACHE_URI}ImagePicker/a.heic`, `${FAKE_CACHE_URI}ImagePicker/b.heic`];
const prepared = (source: string): string => source.replace('ImagePicker', 'prepared');

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  ImageManipulator: {
    // Opened on the picked file's URI, then on the decoded image for the resize.
    manipulate: (source: string | { source: string }) => {
      const origin = typeof source === 'string' ? source : source.source;
      const context = {
        resize: () => context,
        release: () => undefined,
        renderAsync: () =>
          Promise.resolve({
            source: origin,
            width: 4032,
            height: 3024,
            saveAsync: () =>
              Promise.resolve({
                uri: origin.replace('ImagePicker', 'prepared'),
                width: 2560,
                height: 1920,
              }),
            release: () => undefined,
          }),
      };
      return context;
    },
  },
}));

const ORDER_ID = 'order-1';
const PRESIGN = `/orders/${ORDER_ID}/messages/attachments`;

/** Every request, in order, as `METHOD path`. */
let log: string[] = [];
let presigned = 0;
/** Set to make the next `PUT` to storage fail. */
let refuseUpload = false;

function installTransport(): void {
  global.fetch = ((input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    const url = new URL(request.url);
    log.push(`${request.method} ${url.pathname}`);
    return Promise.resolve(answer(request, url));
  }) as typeof fetch;
}

/** What the fake API and storage answer, by request. */
function answer(request: Request, url: URL): Response {
  if (request.method === 'POST' && url.pathname === PRESIGN) {
    presigned += 1;
    const id = `attachment-${String(presigned)}`;
    return Response.json({
      attachmentId: id,
      uploadUrl: `https://storage.test/upload/${id}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      contentType: 'image/jpeg',
      maxBytes: 10_000_000,
    });
  }
  if (request.method === 'PUT') {
    const status = refuseUpload ? 403 : 200;
    refuseUpload = false;
    return new Response(null, { status });
  }
  if (url.pathname.endsWith('/confirm')) {
    return Response.json({ id: url.pathname.split('/').at(-2) });
  }
  return new Response(null, { status: 404 });
}

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Provider store={createTestStore()}>{children}</Provider>;
}

function offer(uris: readonly string[]): void {
  jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({
    canceled: false,
    assets: uris.map((uri) => ({ uri, width: 4032, height: 3024 })),
  } as unknown as ImagePicker.ImagePickerResult);
}

beforeEach(() => {
  fakeFiles.reset();
  log = [];
  presigned = 0;
  refuseUpload = false;
  installTransport();
});

/** #456, ADR-0067: photos for the next message. */
describe('useMessagePhotos', () => {
  it('uploads photos picked together one after the other, and hands them to a send', async () => {
    offer(PICKED);
    const { result } = await renderHook(() => useMessagePhotos(ORDER_ID), { wrapper });

    await act(async () => {
      await result.current.pick();
    });
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    // One outstanding presign per side: the second waits for the first to confirm.
    expect(log).toEqual([
      `POST ${PRESIGN}`,
      'PUT /upload/attachment-1',
      `POST ${PRESIGN}/attachment-1/confirm`,
      `POST ${PRESIGN}`,
      'PUT /upload/attachment-2',
      `POST ${PRESIGN}/attachment-2/confirm`,
    ]);
    // The prepared JPEGs are what went up, never the HEICs.
    expect(fakeFiles.reads).toEqual(PICKED.map(prepared));

    let taken: ReturnType<typeof result.current.take> = [];
    await act(async () => {
      taken = result.current.take();
      await Promise.resolve();
    });

    expect(taken).toEqual([
      { attachmentId: 'attachment-1', uri: prepared(PICKED[0] ?? '') },
      { attachmentId: 'attachment-2', uri: prepared(PICKED[1] ?? '') },
    ]);
    expect(result.current.photos).toEqual([]);
    // The send owns the JPEGs now; only the picker's copies are gone.
    expect(fakeFiles.deleted).toEqual(PICKED);
  });

  it('asks the picker for no more than the message has room for, without EXIF', async () => {
    offer([PICKED[0] ?? '']);
    const { result } = await renderHook(() => useMessagePhotos(ORDER_ID), { wrapper });

    await act(async () => {
      await result.current.pick();
    });

    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ exif: false, selectionLimit: MAX_PHOTOS_PER_MESSAGE }),
    );
  });

  it('keeps a failed photo out of a send until it is removed, and deletes its file', async () => {
    refuseUpload = true;
    offer([PICKED[0] ?? '']);
    const { result } = await renderHook(() => useMessagePhotos(ORDER_ID), { wrapper });

    await act(async () => {
      await result.current.pick();
    });
    await waitFor(() => {
      expect(result.current.photos[0]?.status).toBe('failed');
    });
    expect(result.current.ready).toBe(false);

    await act(async () => {
      result.current.remove(result.current.photos[0]?.localId ?? '');
      await Promise.resolve();
    });

    expect(result.current.photos).toEqual([]);
    expect(result.current.ready).toBe(true);
    expect(fakeFiles.deleted).toContain(prepared(PICKED[0] ?? ''));
  });

  it('deletes the files of photos never sent when the conversation closes', async () => {
    offer([PICKED[0] ?? '']);
    const { result, unmount } = await renderHook(() => useMessagePhotos(ORDER_ID), { wrapper });

    await act(async () => {
      await result.current.pick();
    });
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    await act(async () => {
      await unmount();
    });

    expect(fakeFiles.deleted).toEqual([PICKED[0], prepared(PICKED[0] ?? '')]);
  });
});
