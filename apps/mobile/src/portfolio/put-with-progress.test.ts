import { fakeFiles } from '../../test/support/fake-file-system';
import { installFakeXhr, type FakeXhrControl } from '../../test/support/fake-xhr';
import { isAbortError, putWithProgress } from './put-with-progress';

const URL = 'https://storage.test/upload/1';

/** A JPEG's first bytes, as the prepared file on disk. */
const PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

let xhr: FakeXhrControl;

beforeEach(() => {
  fakeFiles.reset();
  fakeFiles.contents.set('file:///cache/photo.jpg', PHOTO_BYTES);
  // Any read through `fetch` would be the bug in #379: it answered a local
  // URI with "File not found" on a device.
  global.fetch = () => Promise.reject(new Error('a local file must not be read with fetch'));
  xhr = installFakeXhr();
  xhr.hold = true;
});

async function sent(): Promise<void> {
  // The file is read first; the `PUT` follows on a later tick.
  for (let i = 0; i < 5 && xhr.puts.length === 0; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

describe('putWithProgress', () => {
  it('sends the file with its content type and reports its progress to the end', async () => {
    const progress: number[] = [];
    const done = putWithProgress({
      url: URL,
      fileUri: 'file:///cache/photo.jpg',
      contentType: 'image/jpeg',
      onProgress: (fraction) => progress.push(fraction),
    });
    await sent();

    expect(xhr.puts[0]).toEqual(expect.objectContaining({ url: URL, contentType: 'image/jpeg' }));
    // The file's own bytes, read through the file system (#379).
    expect(fakeFiles.reads).toEqual(['file:///cache/photo.jpg']);
    expect(xhr.puts[0]!.body).toEqual(PHOTO_BYTES);
    xhr.puts[0]!.progress(25, 100);
    xhr.puts[0]!.progress(75, 100);
    xhr.puts[0]!.finish(200);
    await done;

    expect(progress).toEqual([0.25, 0.75, 1]);
  });

  it('fails when storage refuses the upload', async () => {
    const done = putWithProgress({
      url: URL,
      fileUri: 'file:///cache/photo.jpg',
      contentType: 'image/jpeg',
      onProgress: () => undefined,
    });
    await sent();
    xhr.puts[0]!.finish(403);

    await expect(done).rejects.toThrow('upload rejected with 403');
  });

  it('stops when aborted, with an error that says so', async () => {
    const abort = new AbortController();
    const done = putWithProgress({
      url: URL,
      fileUri: 'file:///cache/photo.jpg',
      contentType: 'image/jpeg',
      onProgress: () => undefined,
      signal: abort.signal,
    });
    await sent();
    abort.abort();

    const error = await done.catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
    expect(xhr.puts[0]!.aborted).toBe(true);
  });

  it('gives up on a stalled connection after its timeout', async () => {
    const done = putWithProgress({
      url: URL,
      fileUri: 'file:///cache/photo.jpg',
      contentType: 'image/jpeg',
      onProgress: () => undefined,
    });
    await sent();
    xhr.puts[0]!.timeOut();

    await expect(done).rejects.toThrow('upload timed out');
  });
});
