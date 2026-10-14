/**
 * The image-processing boundary
 * ([ADR-0045](docs/decisions/ADR-0045-master-portfolio.md) § 5).
 *
 * No `sharp` type crosses it, for the reason `StorageProvider` keeps no AWS
 * type: the implementation can change — a different library, a separate
 * service — without any caller noticing. Everything here is a path, a number
 * or a stable code.
 */

/** One output the pipeline makes from an upload. */
export interface RenditionSpec {
  /** The file name in the key: `portfolio/<random>/<name>.webp`. */
  readonly name: string;
  /** The longest edge, in pixels. The image fits inside a square of this side. */
  readonly longEdge: number;
  /** WebP quality, 1–100. */
  readonly quality: number;
}

/**
 * A portfolio photo's two renditions, as ADR-0045 § 5 fixes them: a grid
 * tile and a full-screen view. The avatar's square renditions are #309's.
 */
export const PORTFOLIO_RENDITIONS: readonly RenditionSpec[] = Object.freeze([
  Object.freeze({ name: 'thumb', longEdge: 480, quality: 75 }),
  Object.freeze({ name: 'display', longEdge: 1440, quality: 80 }),
]);

export interface RenderImageInput {
  /** The raw upload, already downloaded. Its bytes are untrusted. */
  readonly inputPath: string;
  /** Where to write the renditions. The caller owns it and removes it. */
  readonly outputDir: string;
  readonly renditions: readonly RenditionSpec[];
}

/** A rendition on local disk, before it is stored. */
export interface RenderedImage {
  readonly name: string;
  readonly filePath: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/**
 * Why an upload cannot be processed, as stored in `failure_code` and shown to
 * a client. Stable: the mobile app maps each one to a message.
 *
 * - `missing` — the raw object was not in storage.
 * - `too_large` — the raw object is over its byte cap.
 * - `heic_unsupported` — an HEIC photo; the phone must convert it (#319).
 * - `unsupported_format` — not JPEG, PNG or WebP, whatever it was declared as.
 * - `too_many_pixels` — over `MEDIA_MAX_INPUT_PIXELS`; a decompression bomb,
 *   or a photo far larger than a phone sends.
 * - `undecodable` — claims a supported format but is truncated or corrupt.
 * - `processing_failed` — every attempt failed for a reason that was not the
 *   image's fault (storage, disk); the retries ran out.
 */
export type MediaFailureCode =
  | 'missing'
  | 'too_large'
  | 'heic_unsupported'
  | 'unsupported_format'
  | 'too_many_pixels'
  | 'undecodable'
  | 'processing_failed';

/**
 * The upload itself is the problem, so another attempt would fail the same
 * way. Carries the code and nothing from the image or the library's message,
 * which can echo file contents.
 */
export class MediaProcessingError extends Error {
  constructor(readonly code: MediaFailureCode) {
    super(`The upload cannot be processed: ${code}`);
    this.name = 'MediaProcessingError';
    Object.setPrototypeOf(this, MediaProcessingError.prototype);
  }
}

/**
 * Turns an upload into renditions.
 *
 * It decides what the input is from its bytes, never from a declared type,
 * and refuses anything that is not a JPEG, PNG or WebP before a decoder sees
 * it. Throws {@link MediaProcessingError} when the image is the problem; any
 * other error is the environment's (a full disk) and worth a retry.
 */
export interface MediaProcessor {
  renderImage(input: RenderImageInput): Promise<readonly RenderedImage[]>;
}

/** DI token for {@link MediaProcessor}. */
export const MEDIA_PROCESSOR = Symbol('MEDIA_PROCESSOR');
