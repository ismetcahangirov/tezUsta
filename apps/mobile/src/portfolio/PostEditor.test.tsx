import type { MasterPublicService } from '@tezusta/types';
import { act, fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { installFakeXhr, type FakeXhrControl } from '../../test/support/fake-xhr';
import { createTestStore } from '../../test/support/test-store';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';
import { PostEditor } from './PostEditor';
import { PORTFOLIO_MAX_ITEMS_PER_POST } from './usePortfolioUpload';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

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

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  ImageManipulator: {
    manipulate: () => {
      const context = {
        resize: () => context,
        release: () => undefined,
        renderAsync: () =>
          Promise.resolve({
            width: 2560,
            height: 1920,
            saveAsync: () =>
              Promise.resolve({ uri: 'file:///cache/photo.jpg', width: 2560, height: 1920 }),
            release: () => undefined,
          }),
      };
      return context;
    },
  },
}));

const POST_ID = '00000000-0000-4000-8000-000000000001';
const SERVICES: MasterPublicService[] = [
  { serviceId: 'svc-plumbing', name: 'Santexnik', priceMinor: 2500 },
  { serviceId: 'svc-heating', name: 'Kombi təmiri', priceMinor: null },
];

interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

let calls: ApiCall[] = [];
let presigned = 0;
let publishStatus = 200;
/** What the next publishes answer, in turn, before `publishStatus` applies. */
let publishReplies: { status: number; code?: string }[] = [];
/** The draft's photos as the server holds them, for a reconcile's read. */
let serverMedia: { id: string; position: number }[] = [];
let xhr: FakeXhrControl;

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

    const base = '/masters/me/portfolio/posts';
    if (request.method === 'POST' && url.pathname === base) {
      return Response.json({ id: POST_ID, status: 'draft', media: [] });
    }
    if (url.pathname === `${base}/${POST_ID}/media`) {
      presigned += 1;
      return Response.json({
        mediaId: `media-${String(presigned)}`,
        uploadUrl: `https://storage.test/upload/${String(presigned)}`,
        expiresAt: '2026-10-16T10:05:00.000Z',
        contentType: 'image/jpeg',
        maxBytes: 15_000_000,
      });
    }
    if (url.pathname.endsWith('/confirm')) {
      return Response.json({ id: 'm', status: 'uploaded' });
    }
    if (request.method === 'GET' && url.pathname === `${base}/${POST_ID}`) {
      return Response.json({
        id: POST_ID,
        status: 'draft',
        media: serverMedia.map((media) => ({ ...media, status: 'awaiting_upload' })),
      });
    }
    if (url.pathname === `${base}/${POST_ID}/publish` && publishReplies.length > 0) {
      const next = publishReplies.shift()!;
      return next.status === 200
        ? Response.json({ id: POST_ID, status: 'processing', media: [] })
        : Response.json(
            { error: { code: next.code, message: 'refused' } },
            { status: next.status },
          );
    }
    if (url.pathname === `${base}/${POST_ID}/publish`) {
      return publishStatus === 200
        ? Response.json({ id: POST_ID, status: 'processing', media: [] })
        : Response.json({ code: 'INTERNAL' }, { status: publishStatus });
    }
    if (request.method === 'PATCH') {
      return Response.json({ id: POST_ID, status: 'draft', media: [] });
    }
    if (request.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

async function mount(): Promise<jest.Mock> {
  const onClose = jest.fn();
  await render(
    <Provider store={createTestStore()}>
      <PostEditor services={SERVICES} onClose={onClose} />
    </Provider>,
  );
  return onClose;
}

function publishButton(): ReturnType<typeof screen.getByRole> {
  return screen.getByRole('button', { name: copy.editor.publish });
}

async function addPhotos(count: number): Promise<void> {
  mockPicked = Array.from({ length: count }, (_, i) => ({ uri: `file:///DCIM/${String(i)}.HEIC` }));
  await userEvent.press(
    screen.getByRole('button', { name: copy.editor.addPhotos(0, PORTFOLIO_MAX_ITEMS_PER_POST) }),
  );
}

beforeEach(() => {
  calls = [];
  presigned = 0;
  publishStatus = 200;
  publishReplies = [];
  serverMedia = [];
  mockPicked = [];
  installTransport();
  xhr = installFakeXhr();
});

describe('PostEditor', () => {
  it('publishes the photos with their caption and service once every one has uploaded', async () => {
    xhr.hold = true;
    const onClose = await mount();

    expect(publishButton()).toBeDisabled();
    expect(screen.getByText(copy.editor.publishHint)).toBeOnTheScreen();

    await addPhotos(2);
    await waitFor(() => {
      expect(xhr.puts).toHaveLength(2);
    });
    expect(publishButton()).toBeDisabled();

    await act(() => {
      xhr.puts.forEach((put) => {
        put.finish();
      });
    });
    await waitFor(() => {
      expect(publishButton()).toBeEnabled();
    });
    expect(screen.queryByText(copy.editor.publishHint)).not.toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: copy.editor.addPhotos(2, PORTFOLIO_MAX_ITEMS_PER_POST) }),
    ).toBeOnTheScreen();

    await fireEvent.changeText(screen.getByLabelText(copy.editor.caption), '  Kran dəyişildi  ');
    expect(screen.getByText(copy.editor.counter(18, 500))).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Santexnik' }));
    expect(
      screen.getByRole('button', { name: `Santexnik, ${copy.editor.selected}` }),
    ).toBeOnTheScreen();

    await userEvent.press(publishButton());

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({ caption: 'Kran dəyişildi', serviceId: 'svc-plumbing' });
    const publishIndex = calls.findIndex((call) => call.path.endsWith('/publish'));
    expect(publishIndex).toBeGreaterThan(calls.indexOf(patch!));
  });

  it('clears the service when the chosen one is tapped again', async () => {
    await mount();

    await userEvent.press(screen.getByRole('button', { name: 'Kombi təmiri' }));
    await userEvent.press(
      screen.getByRole('button', { name: `Kombi təmiri, ${copy.editor.selected}` }),
    );

    expect(screen.getByRole('button', { name: 'Kombi təmiri' })).toBeOnTheScreen();
  });

  it('leaves at once when nothing was chosen', async () => {
    const onClose = await mount();

    await userEvent.press(screen.getByRole('button', { name: copy.editor.back }));

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText(copy.editor.leaveTitle)).not.toBeOnTheScreen();
  });

  it('asks before abandoning chosen photos, and deletes the draft on "At"', async () => {
    const onClose = await mount();
    await addPhotos(1);
    await waitFor(() => {
      expect(publishButton()).toBeEnabled();
    });

    await userEvent.press(screen.getByRole('button', { name: copy.editor.back }));
    expect(screen.getByText(copy.editor.leaveTitle)).toBeOnTheScreen();

    const keepGoing = screen.getAllByRole('button', { name: copy.editor.leaveContinue });
    await userEvent.press(keepGoing[keepGoing.length - 1]!);
    expect(screen.queryByText(copy.editor.leaveTitle)).not.toBeOnTheScreen();
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.press(screen.getByRole('button', { name: copy.editor.back }));
    await userEvent.press(screen.getByRole('button', { name: copy.editor.leaveDiscard }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(calls).toContainEqual({
      method: 'DELETE',
      path: `/masters/me/portfolio/posts/${POST_ID}`,
      body: undefined,
    });
  });

  it('keeps the draft and says so when publishing fails', async () => {
    publishStatus = 500;
    const onClose = await mount();
    await addPhotos(1);
    await waitFor(() => {
      expect(publishButton()).toBeEnabled();
    });

    await userEvent.press(publishButton());

    expect(
      await screen.findByText(copy.editor.publishFailed, undefined, { timeout: 10_000 }),
    ).toBeOnTheScreen();
    expect(onClose).not.toHaveBeenCalled();
  }, 30_000);

  it('marks a photo that failed to upload, and uploads it again on retry', async () => {
    xhr.refused.add('https://storage.test/upload/1');
    await mount();
    await addPhotos(1);

    const retry = await screen.findByRole('button', { name: copy.editor.retryPhoto });
    expect(screen.getByText(copy.editor.photoFailed)).toBeOnTheScreen();
    expect(publishButton()).toBeDisabled();

    await userEvent.press(retry);

    await waitFor(() => {
      expect(publishButton()).toBeEnabled();
    });
    expect(screen.queryByText(copy.editor.photoFailed)).not.toBeOnTheScreen();
  });

  it('removes a chosen photo', async () => {
    await mount();
    await addPhotos(2);
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: copy.editor.removePhoto })).toHaveLength(2);
    });

    await userEvent.press(screen.getAllByRole('button', { name: copy.editor.removePhoto })[0]!);

    expect(screen.getAllByRole('button', { name: copy.editor.removePhoto })).toHaveLength(1);
  });

  it('clears a photo the server still holds but the editor does not, then publishes', async () => {
    publishReplies = [{ status: 409, code: 'PORTFOLIO_POST_NOT_READY' }, { status: 200 }];
    const onClose = await mount();
    await addPhotos(1);
    await waitFor(() => {
      expect(publishButton()).toBeEnabled();
    });
    serverMedia = [
      { id: 'media-1', position: 0 },
      { id: 'lost', position: 5 },
    ];

    await userEvent.press(publishButton());

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(calls).toContainEqual({
      method: 'DELETE',
      path: `/masters/me/portfolio/posts/${POST_ID}/media/lost`,
      body: undefined,
    });
    expect(calls.filter((call) => call.path.endsWith('/publish'))).toHaveLength(2);
    expect(screen.queryByText(copy.editor.publishFailed)).not.toBeOnTheScreen();
  });

  it('deletes a draft whose photos were all removed when the editor is left', async () => {
    const onClose = await mount();
    await addPhotos(1);
    await waitFor(() => {
      expect(publishButton()).toBeEnabled();
    });
    await userEvent.press(screen.getByRole('button', { name: copy.editor.removePhoto }));

    await userEvent.press(screen.getByRole('button', { name: copy.editor.back }));

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText(copy.editor.leaveTitle)).not.toBeOnTheScreen();
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'DELETE',
        path: `/masters/me/portfolio/posts/${POST_ID}`,
        body: undefined,
      });
    });
  });
});
