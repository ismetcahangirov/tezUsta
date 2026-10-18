/**
 * `expo-file-system` for Jest, installed for every suite by `jest.setup.js`
 * (#379). The real `File` is backed by a native module that does not exist
 * under Jest.
 *
 * Only what the app uses: `new File(uri).arrayBuffer()`, which is how every
 * photo upload reads the prepared file. A test puts bytes under a URI with
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
  reset(): void {
    this.contents.clear();
    this.reads.length = 0;
  },
};

export class File {
  constructor(readonly uri: string) {}

  arrayBuffer(): Promise<ArrayBuffer> {
    fakeFiles.reads.push(this.uri);
    const bytes = fakeFiles.contents.get(this.uri) ?? DEFAULT_CONTENTS;
    return Promise.resolve(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
  }
}
