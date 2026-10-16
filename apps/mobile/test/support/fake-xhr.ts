/**
 * A stand-in for `XMLHttpRequest`, for the uploads that `PUT` a photo to a
 * presigned URL with progress (`src/portfolio/put-with-progress.ts`).
 *
 * Each `PUT` is recorded. By default it succeeds on its own on the next tick;
 * with `hold` set it waits until the test calls `finish`, so a test can see
 * what is in flight and report progress. A URL in `refused` answers 500.
 */

export interface FakePut {
  readonly url: string;
  readonly contentType: string | null;
  aborted: boolean;
  finish: (status?: number) => void;
  /** The connection stalls past the request's own timeout. */
  timeOut: () => void;
  progress: (loaded: number, total: number) => void;
}

export interface FakeXhrControl {
  readonly puts: FakePut[];
  readonly refused: Set<string>;
  hold: boolean;
  /** The most `PUT`s that were ever in flight at once. */
  mostInFlight: number;
}

type ProgressHandler = (event: {
  lengthComputable: boolean;
  loaded: number;
  total: number;
}) => void;

export function installFakeXhr(): FakeXhrControl {
  const control: FakeXhrControl = { puts: [], refused: new Set(), hold: false, mostInFlight: 0 };
  let inFlight = 0;

  class FakeXhr {
    status = 0;
    upload: { onprogress: ProgressHandler | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    timeout = 0;
    private url = '';
    private contentType: string | null = null;
    private done = false;
    private put: FakePut | null = null;

    open(_method: string, url: string): void {
      this.url = url;
    }

    setRequestHeader(name: string, value: string): void {
      if (name.toLowerCase() === 'content-type') {
        this.contentType = value;
      }
    }

    abort(): void {
      if (this.done) {
        return;
      }
      this.done = true;
      inFlight -= 1;
      if (this.put !== null) {
        this.put.aborted = true;
      }
      this.onabort?.();
    }

    send(): void {
      inFlight += 1;
      control.mostInFlight = Math.max(control.mostInFlight, inFlight);
      const put: FakePut = {
        url: this.url,
        contentType: this.contentType,
        aborted: false,
        progress: (loaded, total) => {
          this.upload.onprogress?.({ lengthComputable: true, loaded, total });
        },
        timeOut: () => {
          if (this.done) {
            return;
          }
          this.done = true;
          inFlight -= 1;
          this.ontimeout?.();
        },
        finish: (status = control.refused.has(this.url) ? 500 : 200) => {
          if (this.done) {
            return;
          }
          this.done = true;
          inFlight -= 1;
          this.status = status;
          this.onload?.();
        },
      };
      this.put = put;
      control.puts.push(put);
      if (!control.hold) {
        setTimeout(() => {
          put.finish();
        }, 0);
      }
    }
  }

  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
  return control;
}
