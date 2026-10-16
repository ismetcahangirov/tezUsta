import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { Provider } from 'react-redux';

import { installFakeXhr } from '../../test/support/fake-xhr';
import { createTestStore } from '../../test/support/test-store';
import { useAvatarUpload } from './useAvatarUpload';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  launchImageLibraryAsync: jest.fn(() =>
    Promise.resolve({ canceled: false, assets: [{ uri: 'file:///DCIM/me.HEIC' }] }),
  ),
}));

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  ImageManipulator: {
    manipulate: () => {
      const context = {
        resize: () => context,
        release: () => undefined,
        renderAsync: () =>
          Promise.resolve({
            width: 1024,
            height: 1024,
            saveAsync: () =>
              Promise.resolve({ uri: 'file:///cache/me.jpg', width: 1024, height: 1024 }),
            release: () => undefined,
          }),
      };
      return context;
    },
  },
}));

const UPLOAD_ID = '00000000-0000-4000-8000-0000000000aa';

/** What each successive read of the upload answers. */
let statuses: string[] = [];
let confirmStatus = 'ready';
let calls: string[] = [];

function installTransport(): void {
  global.fetch = ((input: Request | string, init?: RequestInit): Promise<Response> => {
    const reply = (response: Response): Promise<Response> => Promise.resolve(response);
    const request = typeof input === 'string' ? new Request(input, init) : input;
    const url = new URL(request.url);
    if (url.protocol === 'file:') {
      return reply(new Response('jpeg-bytes'));
    }
    calls.push(`${request.method} ${url.pathname}`);
    const upload = (status: string): Response =>
      Response.json({
        uploadId: UPLOAD_ID,
        status,
        failureCode: status === 'failed' ? 'undecodable' : null,
      });

    if (url.pathname === '/masters/me/avatar/presign') {
      return reply(
        Response.json({
          uploadId: UPLOAD_ID,
          uploadUrl: 'https://storage.test/avatar',
          expiresAt: '2026-10-16T10:05:00.000Z',
          contentType: 'image/jpeg',
          maxBytes: 15_000_000,
        }),
      );
    }
    if (url.pathname === `/masters/me/avatar/${UPLOAD_ID}/confirm`) {
      return reply(upload(confirmStatus));
    }
    if (url.pathname === `/masters/me/avatar/${UPLOAD_ID}`) {
      return reply(upload(statuses.shift() ?? 'ready'));
    }
    if (request.method === 'DELETE') {
      return reply(new Response(null, { status: 204 }));
    }
    return reply(new Response(null, { status: 404 }));
  }) as typeof fetch;
}

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Provider store={createTestStore()}>{children}</Provider>;
}

beforeEach(() => {
  statuses = [];
  confirmStatus = 'ready';
  calls = [];
  installTransport();
  installFakeXhr();
});

describe('useAvatarUpload', () => {
  it('crops square in the picker, uploads, and is done once the avatar is ready', async () => {
    const { result } = await renderHook(() => useAvatarUpload(), { wrapper });

    await act(async () => {
      await result.current.change();
    });

    expect(jest.mocked(ImagePicker.launchImageLibraryAsync)).toHaveBeenCalledWith(
      expect.objectContaining({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1] }),
    );
    expect(calls).toEqual([
      'POST /masters/me/avatar/presign',
      `POST /masters/me/avatar/${UPLOAD_ID}/confirm`,
    ]);
    expect(result.current.phase).toBe('idle');
  });

  it('waits while the new avatar is processed', async () => {
    confirmStatus = 'processing';
    statuses = ['ready'];
    const { result } = await renderHook(() => useAvatarUpload(), { wrapper });

    let changing: Promise<void> = Promise.resolve();
    await act(async () => {
      changing = result.current.change();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.phase).toBe('working');
    });

    await act(async () => {
      await changing;
    });

    expect(calls).toContain(`GET /masters/me/avatar/${UPLOAD_ID}`);
    expect(result.current.phase).toBe('idle');
  }, 15_000);

  it('fails when the new avatar cannot be made, and sends the same photo again on retry', async () => {
    confirmStatus = 'failed';
    const { result } = await renderHook(() => useAvatarUpload(), { wrapper });
    await act(async () => {
      await result.current.change();
    });
    expect(result.current.phase).toBe('failed');

    confirmStatus = 'ready';
    jest.mocked(ImagePicker.launchImageLibraryAsync).mockClear();
    await act(async () => {
      await result.current.retry();
    });

    expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
  });

  it('removes the avatar', async () => {
    const { result } = await renderHook(() => useAvatarUpload(), { wrapper });

    await act(async () => {
      await result.current.remove();
    });

    expect(calls).toEqual(['DELETE /masters/me/avatar']);
  });

  it('says the library was refused, and sends nothing', async () => {
    jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValueOnce({
      granted: false,
    } as Awaited<ReturnType<typeof ImagePicker.requestMediaLibraryPermissionsAsync>>);
    const { result } = await renderHook(() => useAvatarUpload(), { wrapper });

    await act(async () => {
      await result.current.change();
    });

    expect(result.current.permissionDenied).toBe(true);
    expect(calls).toEqual([]);
  });
});
