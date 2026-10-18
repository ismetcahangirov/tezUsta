import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { Provider } from 'react-redux';

import { installFakeXhr, type FakeXhrControl } from '../../test/support/fake-xhr';
import { createTestStore } from '../../test/support/test-store';
import { PORTFOLIO_MAX_ITEMS_PER_POST, usePortfolioUpload } from './usePortfolioUpload';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/** What the iPhone camera saves by default, handed over raw by the picker. */
function heic(n: number): { uri: string; width: number; height: number } {
  return { uri: `file:///DCIM/IMG_000${String(n)}.HEIC`, width: 4032, height: 3024 };
}

let mockPicked: { uri: string }[] = [];

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  launchImageLibraryAsync: jest.fn(() =>
    Promise.resolve(
      mockPicked.length === 0
        ? { canceled: true, assets: null }
        : { canceled: false, assets: mockPicked },
    ),
  ),
}));

/** The manipulator converts each picked file to a JPEG named after it. */
const mockManipulated: string[] = [];

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  ImageManipulator: {
    manipulate: (source: unknown) => {
      if (typeof source === 'string') {
        mockManipulated.push(source);
      }
      const name = typeof source === 'string' ? source.split('/').pop() : 'image';
      const context = {
        resize: () => context,
        release: () => undefined,
        renderAsync: () =>
          Promise.resolve({
            width: 4032,
            height: 3024,
            saveAsync: () =>
              Promise.resolve({
                uri: `file:///cache/${String(name)}.jpg`,
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

const POST_ID = '00000000-0000-4000-8000-000000000001';

interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

let calls: ApiCall[] = [];
let presigned = 0;
/** When the next presigned URL expires. Far ahead unless a test says otherwise. */
let presignExpiresAt = '2099-01-01T00:00:00.000Z';
/** While set, presigns (or the draft's creation) wait for the test to release them. */
let presignGate: Promise<void> | null = null;
let createGate: Promise<void> | null = null;
/** The draft as the server holds it, for a reconcile's read. */
let serverMedia: { id: string; position: number }[] = [];

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** The API, and the local files the photos are read from. */
function installTransport(): void {
  global.fetch = (async (input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.text();
    calls.push({
      method: request.method,
      path: url.pathname,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    });

    if (request.method === 'POST' && url.pathname === '/masters/me/portfolio/posts') {
      await createGate;
      return Response.json({ id: POST_ID, status: 'draft', media: [] });
    }
    if (request.method === 'GET' && url.pathname === `/masters/me/portfolio/posts/${POST_ID}`) {
      return Response.json({
        id: POST_ID,
        status: 'draft',
        media: serverMedia.map((media) => ({ ...media, status: 'awaiting_upload' })),
      });
    }
    if (
      request.method === 'POST' &&
      url.pathname === `/masters/me/portfolio/posts/${POST_ID}/media`
    ) {
      await presignGate;
      presigned += 1;
      return Response.json({
        mediaId: `media-${String(presigned)}`,
        uploadUrl: `https://storage.test/upload/${String(presigned)}`,
        expiresAt: presignExpiresAt,
        contentType: 'image/jpeg',
        maxBytes: 15_000_000,
      });
    }
    if (url.pathname.endsWith('/confirm')) {
      return Response.json({ id: 'confirmed', status: 'uploaded' });
    }
    if (request.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

let xhr: FakeXhrControl;

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Provider store={createTestStore()}>{children}</Provider>;
}

const pickerOptions = (): unknown =>
  jest.mocked(ImagePicker.launchImageLibraryAsync).mock.calls.at(-1)?.[0];

beforeEach(() => {
  calls = [];
  presigned = 0;
  presignExpiresAt = '2099-01-01T00:00:00.000Z';
  presignGate = null;
  createGate = null;
  serverMedia = [];
  mockManipulated.length = 0;
  mockPicked = [heic(1), heic(2), heic(3)];
  installTransport();
  xhr = installFakeXhr();
  jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValue({
    granted: true,
  } as Awaited<ReturnType<typeof ImagePicker.requestMediaLibraryPermissionsAsync>>);
});

describe('usePortfolioUpload', () => {
  it('uploads every chosen photo into one draft, as JPEG, and is then ready to publish', async () => {
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });

    await act(async () => {
      await result.current.pick();
    });

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    expect(result.current.postId).toBe(POST_ID);
    expect(result.current.items.map((item) => item.status)).toEqual([
      'uploaded',
      'uploaded',
      'uploaded',
    ]);

    // One draft, three presigns at three positions, three confirms.
    expect(calls.filter((call) => call.path === '/masters/me/portfolio/posts')).toHaveLength(1);
    const presigns = calls.filter((call) => call.path.endsWith('/media'));
    expect(presigns.map((call) => call.body)).toEqual([
      { contentType: 'image/jpeg', position: 0 },
      { contentType: 'image/jpeg', position: 1 },
      { contentType: 'image/jpeg', position: 2 },
    ]);
    expect(calls.filter((call) => call.path.endsWith('/confirm'))).toHaveLength(3);
    expect(xhr.puts.map((put) => put.contentType)).toEqual([
      'image/jpeg',
      'image/jpeg',
      'image/jpeg',
    ]);
  });

  it('asks the picker for several images only, within the room left, without EXIF', async () => {
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });

    await act(async () => {
      await result.current.pick();
    });
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    expect(pickerOptions()).toEqual(
      expect.objectContaining({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: PORTFOLIO_MAX_ITEMS_PER_POST,
        exif: false,
      }),
    );

    mockPicked = [heic(4)];
    await act(async () => {
      await result.current.pick();
    });
    expect(pickerOptions()).toEqual(
      expect.objectContaining({ selectionLimit: PORTFOLIO_MAX_ITEMS_PER_POST - 3 }),
    );
  });

  it('converts an iPhone HEIC to JPEG before a byte is uploaded', async () => {
    mockPicked = [heic(1)];
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });

    await act(async () => {
      await result.current.pick();
    });
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    expect(mockManipulated).toEqual(['file:///DCIM/IMG_0001.HEIC']);
    // The strip now draws the converted file, not the HEIC.
    expect(result.current.items[0]?.previewUri).toMatch(/^file:\/\/\/cache\/.+\.jpg$/);
  });

  it('uploads two at a time, and reports each one’s progress', async () => {
    xhr.hold = true;
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });

    let picking: Promise<void> = Promise.resolve();
    await act(async () => {
      picking = result.current.pick();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(xhr.puts).toHaveLength(2);
    });
    expect(xhr.mostInFlight).toBe(2);

    await act(async () => {
      xhr.puts[0]!.progress(40, 100);
      await Promise.resolve();
    });
    expect(result.current.items[0]).toEqual(
      expect.objectContaining({ status: 'uploading', progress: 0.4 }),
    );

    await act(async () => {
      xhr.puts[0]!.finish();
      xhr.puts[1]!.finish();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(xhr.puts).toHaveLength(3);
    });
    await act(async () => {
      xhr.puts[2]!.finish();
      await picking;
    });

    expect(xhr.mostInFlight).toBe(2);
    expect(result.current.ready).toBe(true);
  });

  it('marks one failed photo and carries on with the others', async () => {
    xhr.refused.add('https://storage.test/upload/2');
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });

    await act(async () => {
      await result.current.pick();
    });

    await waitFor(() => {
      expect(result.current.items.map((item) => item.status)).toEqual([
        'uploaded',
        'failed',
        'uploaded',
      ]);
    });
    expect(result.current.ready).toBe(false);
  });

  it('retries a failed photo at the same URL and position while the URL is valid', async () => {
    xhr.refused.add('https://storage.test/upload/1');
    mockPicked = [heic(1)];
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });
    await act(async () => {
      await result.current.pick();
    });
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe('failed');
    });

    xhr.refused.clear();
    await act(() => {
      result.current.retry(result.current.items[0]!.localId);
    });

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    expect(calls.filter((call) => call.path.endsWith('/media'))).toHaveLength(1);
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(xhr.puts.map((put) => put.url)).toEqual([
      'https://storage.test/upload/1',
      'https://storage.test/upload/1',
    ]);
  });

  it('frees an expired URL on retry and presigns the same position again', async () => {
    presignExpiresAt = '2000-01-01T00:00:00.000Z';
    xhr.refused.add('https://storage.test/upload/1');
    mockPicked = [heic(1), heic(2)];
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });
    await act(async () => {
      await result.current.pick();
    });
    await waitFor(() => {
      expect(result.current.items.map((item) => item.status)).toEqual(['failed', 'uploaded']);
    });

    await act(() => {
      result.current.retry(result.current.items[0]!.localId);
    });

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    expect(calls).toContainEqual({
      method: 'DELETE',
      path: `/masters/me/portfolio/posts/${POST_ID}/media/media-1`,
      body: undefined,
    });
    expect(calls.filter((call) => call.path.endsWith('/media')).map((call) => call.body)).toEqual([
      { contentType: 'image/jpeg', position: 0 },
      { contentType: 'image/jpeg', position: 1 },
      { contentType: 'image/jpeg', position: 0 },
    ]);
  });

  it('deletes the row of a photo removed while its presign was on its way, and frees its place', async () => {
    const presign = gate();
    presignGate = presign.promise;
    mockPicked = [heic(1)];
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });
    await act(async () => {
      await result.current.pick();
    });
    await waitFor(() => {
      expect(calls.some((call) => call.path.endsWith('/media'))).toBe(true);
    });

    await act(async () => {
      result.current.remove(result.current.items[0]!.localId);
      presign.release();
      await presign.promise;
    });

    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'DELETE',
        path: `/masters/me/portfolio/posts/${POST_ID}/media/media-1`,
        body: undefined,
      });
    });
    expect(xhr.puts).toEqual([]);

    // The freed place is the next photo's.
    presignGate = null;
    mockPicked = [heic(2)];
    await act(async () => {
      await result.current.pick();
    });
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    expect(calls.filter((call) => call.path.endsWith('/media')).at(-1)?.body).toEqual({
      contentType: 'image/jpeg',
      position: 0,
    });
  });

  it('keeps two uploads at a time across separate picks', async () => {
    xhr.hold = true;
    mockPicked = [heic(1), heic(2)];
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });
    await act(async () => {
      await result.current.pick();
    });
    await waitFor(() => {
      expect(xhr.puts).toHaveLength(2);
    });

    mockPicked = [heic(3), heic(4)];
    await act(async () => {
      await result.current.pick();
    });
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    });

    expect(xhr.puts).toHaveLength(2);
    expect(xhr.mostInFlight).toBe(2);
  });

  it('creates no draft after the post was abandoned while a photo was preparing', async () => {
    const create = gate();
    createGate = create.promise;
    mockPicked = [heic(1)];
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });
    await act(async () => {
      await result.current.pick();
    });
    await waitFor(() => {
      expect(calls.filter((call) => call.path === '/masters/me/portfolio/posts')).toHaveLength(1);
    });

    let discarding: Promise<void> = Promise.resolve();
    await act(async () => {
      discarding = result.current.discard();
      create.release();
      await discarding;
    });

    // The one draft made is deleted, no photo is presigned into it, and no other draft appears.
    expect(
      calls.filter((call) => call.method === 'POST' && call.path === '/masters/me/portfolio/posts'),
    ).toHaveLength(1);
    expect(calls.some((call) => call.path.endsWith('/media'))).toBe(false);
    expect(calls).toContainEqual({
      method: 'DELETE',
      path: `/masters/me/portfolio/posts/${POST_ID}`,
      body: undefined,
    });
  });

  it('reconciles the draft with the server, deleting photos it no longer holds', async () => {
    mockPicked = [heic(1)];
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });
    await act(async () => {
      await result.current.pick();
    });
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    serverMedia = [
      { id: 'media-1', position: 0 },
      { id: 'stray', position: 3 },
    ];

    let changed = false;
    await act(async () => {
      changed = await result.current.reconcile();
    });

    expect(changed).toBe(true);
    expect(calls).toContainEqual({
      method: 'DELETE',
      path: `/masters/me/portfolio/posts/${POST_ID}/media/stray`,
      body: undefined,
    });
    expect(calls).not.toContainEqual(
      expect.objectContaining({ path: `/masters/me/portfolio/posts/${POST_ID}/media/media-1` }),
    );
  });

  it('removes a photo, stopping its upload and taking it out of the draft', async () => {
    xhr.hold = true;
    mockPicked = [heic(1)];
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });
    await act(async () => {
      void result.current.pick();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(xhr.puts).toHaveLength(1);
    });

    await act(async () => {
      result.current.remove(result.current.items[0]!.localId);
      await Promise.resolve();
    });

    expect(result.current.items).toEqual([]);
    expect(xhr.puts[0]!.aborted).toBe(true);
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'DELETE',
        path: `/masters/me/portfolio/posts/${POST_ID}/media/media-1`,
        body: undefined,
      });
    });
  });

  it('deletes the draft when the post is abandoned', async () => {
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });
    await act(async () => {
      await result.current.pick();
    });
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    await act(async () => {
      await result.current.discard();
    });

    expect(calls).toContainEqual({
      method: 'DELETE',
      path: `/masters/me/portfolio/posts/${POST_ID}`,
      body: undefined,
    });
    expect(result.current.items).toEqual([]);
    expect(result.current.postId).toBeNull();
  });

  it('creates nothing when the picker is closed without a choice', async () => {
    mockPicked = [];
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });

    await act(async () => {
      await result.current.pick();
    });

    expect(result.current.items).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('says the library permission was refused, and picks nothing', async () => {
    jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValue({
      granted: false,
    } as Awaited<ReturnType<typeof ImagePicker.requestMediaLibraryPermissionsAsync>>);
    const { result } = await renderHook(() => usePortfolioUpload(), { wrapper });

    await act(async () => {
      await result.current.pick();
    });

    expect(result.current.permissionDenied).toBe(true);
    expect(calls).toEqual([]);
  });
});
