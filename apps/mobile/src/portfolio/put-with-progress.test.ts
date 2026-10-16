import { installFakeXhr, type FakeXhrControl } from '../../test/support/fake-xhr';
import { isAbortError, putWithProgress } from './put-with-progress';

const URL = 'https://storage.test/upload/1';

let xhr: FakeXhrControl;

beforeEach(() => {
  global.fetch = () => Promise.resolve(new Response('jpeg-bytes'));
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
