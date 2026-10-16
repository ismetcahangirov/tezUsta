export interface PutWithProgressArgs {
  /** The presigned `PUT` URL. */
  readonly url: string;
  /** The prepared local file. */
  readonly fileUri: string;
  readonly contentType: string;
  /** 0 to 1, as the bytes leave the phone. */
  readonly onProgress: (fraction: number) => void;
  /** Aborts the upload: the photo was removed, or the editor closed. */
  readonly signal?: AbortSignal;
}

/**
 * How long one photo's `PUT` may take before it counts as failed. A stalled
 * mobile connection otherwise leaves the photo "uploading" for ever, with no
 * retry offered. A prepared photo is about a megabyte: a minute is generous on
 * a slow line.
 */
export const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * `PUT`s a local file to a presigned URL, reporting how much has been sent.
 *
 * **`XMLHttpRequest`, not `fetch`**: React Native's `fetch` reports no upload
 * progress, and ADR-0054 § 5 draws a progress bar on every photo while it
 * uploads. `XMLHttpRequest` reports it through `upload.onprogress`.
 *
 * **The file is read into memory first.** A prepared photo is a JPEG capped at
 * 2560 px, about a megabyte (`prepare-photo.ts`), so that is cheap. A video
 * would not be, which is why #314 called for a streaming upload; video is
 * deferred (ADR-0045 § 7), and this would be the place to change.
 */
export async function putWithProgress({
  url,
  fileUri,
  contentType,
  onProgress,
  signal,
}: PutWithProgressArgs): Promise<void> {
  const file = await fetch(fileUri).then(async (response) => response.blob());
  if (signal?.aborted === true) {
    throw abortError();
  }

  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = (): void => {
      request.abort();
    };

    request.open('PUT', url);
    request.timeout = UPLOAD_TIMEOUT_MS;
    request.setRequestHeader('content-type', contentType);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(event.loaded / event.total, 1));
      }
    };
    request.onload = () => {
      signal?.removeEventListener('abort', abort);
      if (request.status >= 200 && request.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new Error(`upload rejected with ${String(request.status)}`));
      }
    };
    request.onerror = () => {
      signal?.removeEventListener('abort', abort);
      reject(new Error('upload failed'));
    };
    request.ontimeout = () => {
      signal?.removeEventListener('abort', abort);
      reject(new Error('upload timed out'));
    };
    request.onabort = () => {
      reject(abortError());
    };

    signal?.addEventListener('abort', abort, { once: true });
    request.send(file);
  });
}

/**
 * An abort, told apart from a failure by its name. Built by hand: React
 * Native's runtime has neither `DOMException` nor `AbortSignal.throwIfAborted`.
 */
function abortError(): Error {
  const error = new Error('upload aborted');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
