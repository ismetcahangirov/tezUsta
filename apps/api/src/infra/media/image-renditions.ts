import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import {
  IMAGE_SIGNATURE_BYTES,
  isHeicSignature,
  sniffImageContentType,
} from '../storage/image-content-type';
import { MediaProcessingError } from './media-processor.types';
import type {
  MediaProcessor,
  RenderImageInput,
  RenderedImage,
  RenditionSpec,
} from './media-processor.types';

export interface ImageRenditionsOptions {
  /** `MEDIA_MAX_INPUT_PIXELS`: the decompression-bomb guard. */
  readonly maxInputPixels: number;
}

/**
 * WebP renditions with `sharp` (ADR-0045 § 5).
 *
 * Per rendition, in this order:
 *
 * 1. **Decode under limits.** `limitInputPixels` refuses a decompression bomb
 *    from its header, before the pixels are allocated. `failOn: 'warning'`
 *    refuses a truncated or damaged file instead of rendering half of it.
 *    `animated: false` takes the first frame of an animated WebP.
 * 2. **`autoOrient()`** applies the EXIF orientation to the pixels. Without
 *    it, stripping the metadata below would leave every portrait photo
 *    sideways, because the tag that said "rotate me" would be gone.
 * 3. **Resize to fit** a square of the rendition's long edge, never enlarged —
 *    or, for a `cover` rendition, fill the square and crop the centre.
 * 4. **sRGB**, so a Display P3 photo from an iPhone looks the same on every
 *    phone once its ICC profile is gone.
 * 5. **WebP**, with `smartSubsample` to keep thin coloured edges sharp.
 *
 * **Metadata is never kept.** `keepMetadata()` and `withMetadata()` appear
 * nowhere, and `sharp` strips EXIF (with any GPS), XMP, IPTC and ICC by
 * default. Location is PII (CLAUDE.md § 11); a test reads every rendition's
 * metadata back to prove it.
 */
export class ImageRenditions implements MediaProcessor {
  constructor(private readonly options: ImageRenditionsOptions) {
    // libvips caches open files and recent operations, which a server that
    // never sees the same image twice gains nothing from. It also holds the
    // input open after the job, so on Windows the temp directory could not
    // be removed. Process-wide, and set once, here.
    sharp.cache(false);
    // libvips runs a thread pool of its own per image, sized to the cores.
    // With the queue at one job at a time, one libvips thread costs about a
    // tenth more wall time per photo (measured on a 12 MP JPEG) and leaves
    // the other cores to the API it shares the process with.
    sharp.concurrency(1);
  }

  async renderImage(input: RenderImageInput): Promise<readonly RenderedImage[]> {
    await refuseUnsupported(input.inputPath);

    const rendered: RenderedImage[] = [];
    for (const spec of input.renditions) {
      rendered.push(await this.render(input.inputPath, input.outputDir, spec));
    }
    return rendered;
  }

  private async render(
    inputPath: string,
    outputDir: string,
    spec: RenditionSpec,
  ): Promise<RenderedImage> {
    const filePath = path.join(outputDir, `${spec.name}.webp`);
    let encoded: { data: Buffer; info: sharp.OutputInfo };
    try {
      encoded = await sharp(inputPath, {
        limitInputPixels: this.options.maxInputPixels,
        failOn: 'warning',
        animated: false,
      })
        .autoOrient()
        .resize(
          spec.fit === 'cover'
            ? { width: spec.longEdge, height: spec.longEdge, fit: 'cover', position: 'centre' }
            : {
                width: spec.longEdge,
                height: spec.longEdge,
                fit: 'inside',
                withoutEnlargement: true,
              },
        )
        .toColourspace('srgb')
        .webp({ quality: spec.quality, smartSubsample: true })
        .toBuffer({ resolveWithObject: true });
    } catch (error) {
      throw classifySharpError(error);
    }
    // Written by Node, not by libvips, which is the point. libvips reports a
    // full disk as a plain error with no errno, indistinguishable from a
    // corrupt image; Node's carries `ENOSPC`, so it is retried rather than
    // blamed on the master's photo. A rendition is a few hundred kilobytes,
    // so holding it in memory first costs nothing.
    await writeFile(filePath, encoded.data);
    return {
      name: spec.name,
      filePath,
      width: encoded.info.width,
      height: encoded.info.height,
      bytes: encoded.info.size,
    };
  }
}

/**
 * The bytes decide, before `sharp` is given the file.
 *
 * The prebuilt `sharp` also decodes SVG, TIFF, GIF and AVIF. None of them is
 * on the allow-list, and SVG in particular is a document with its own parser
 * behind it. The confirm step sniffed the same bytes already; this is the
 * same check at the place the bytes are decoded, so that nothing reaches the
 * decoder on the strength of a check made somewhere else.
 */
async function refuseUnsupported(inputPath: string): Promise<void> {
  const file = await open(inputPath, 'r');
  let header: Uint8Array;
  try {
    const buffer = Buffer.alloc(IMAGE_SIGNATURE_BYTES);
    const { bytesRead } = await file.read(buffer, 0, IMAGE_SIGNATURE_BYTES, 0);
    header = buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }

  if (isHeicSignature(header)) {
    throw new MediaProcessingError('heic_unsupported');
  }
  if (sniffImageContentType(header) === null) {
    throw new MediaProcessingError('unsupported_format');
  }
}

/**
 * `sharp` reports everything as a plain `Error` with a libvips message. The
 * pixel limit has a message of its own; every other failure while decoding
 * and encoding a file whose signature was valid is a damaged file. Nothing
 * here writes to disk — `render` does that through Node — so a disk problem
 * never reaches this function.
 */
function classifySharpError(error: unknown): MediaProcessingError {
  const message = error instanceof Error ? error.message : '';
  if (/exceeds pixel limit/i.test(message)) {
    return new MediaProcessingError('too_many_pixels');
  }
  return new MediaProcessingError('undecodable');
}
