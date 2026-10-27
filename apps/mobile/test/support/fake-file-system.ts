/**
 * `expo-file-system` for Jest, installed for every suite by `jest.setup.js`
 * (#379). The real `File` is backed by a native module that does not exist
 * under Jest.
 *
 * Only what the app uses: `new File(uri).arrayBuffer()`, which is how every
 * photo upload reads the prepared file, and `exists` / `delete()` with
 * `Paths.cache`, which is how the cached copies are discarded (#408), and
 * `new Directory(Paths.cache, name).list()`, which is how the cold-start sweep
 * finds them (#458). A test puts bytes under a URI with
 * {@link fakeFiles} and can see which URIs were read; a URI with nothing put
 * under it reads as a few fixed bytes, so a test that does not care about the
 * contents still uploads something.
 */

const DEFAULT_CONTENTS = new TextEncoder().encode('jpeg-bytes');

export const fakeFiles = {
  /** Bytes by file URI. */
  contents: new Map<string, Uint8Array>(),
  /** Every URI read, in order. */
  reads: [] as string[],
  /** Every URI deleted, in order. A deleted file no longer exists. */
  deleted: [] as string[],
  /** When true, `delete()` throws, as a platform refusing it would. */
  deleteFails: false,
  /**
   * What each directory holds, by its URI with a trailing slash: the entry
   * names, a trailing slash marking a subdirectory. A directory absent here
   * does not exist.
   */
  directories: new Map<string, string[]>(),
  /** When true, `list()` throws, as a platform refusing it would. */
  listFails: false,
  reset(): void {
    this.contents.clear();
    this.reads.length = 0;
    this.deleted.length = 0;
    this.deleteFails = false;
    this.directories.clear();
    this.listFails = false;
  },
};

/** The app's cache directory, as the fake reports it. */
export const FAKE_CACHE_URI = 'file:///cache/';

export const Paths = {
  cache: { uri: FAKE_CACHE_URI },
};

export class File {
  constructor(readonly uri: string) {}

  get exists(): boolean {
    return !fakeFiles.deleted.includes(this.uri);
  }

  delete(): void {
    if (fakeFiles.deleteFails) {
      throw new Error('delete refused');
    }
    fakeFiles.deleted.push(this.uri);
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    fakeFiles.reads.push(this.uri);
    const bytes = fakeFiles.contents.get(this.uri) ?? DEFAULT_CONTENTS;
    return Promise.resolve(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
  }
}

export class Directory {
  readonly uri: string;

  /** Joined as the real one is: a parent (`Paths.cache`) or URI, then names. */
  constructor(...parts: (string | { readonly uri: string })[]) {
    const joined = parts
      .map((part) => (typeof part === 'string' ? part : part.uri))
      .reduce((parent, name) => `${parent.endsWith('/') ? parent : `${parent}/`}${name}`);
    this.uri = joined.endsWith('/') ? joined : `${joined}/`;
  }

  get exists(): boolean {
    return fakeFiles.directories.has(this.uri);
  }

  list(): (Directory | File)[] {
    const names = fakeFiles.directories.get(this.uri);
    if (fakeFiles.listFails || names === undefined) {
      throw new Error('list refused');
    }
    return names.map((name) =>
      name.endsWith('/') ? new Directory(this.uri, name) : new File(`${this.uri}${name}`),
    );
  }
}
