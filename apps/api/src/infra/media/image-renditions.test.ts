import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  geotaggedTwelveMegapixelJpeg,
  hasGpsIfd,
  orientedPhoto,
  pixelBombPng,
  solidImage,
  transparentPng,
} from '../../../test/support/image-fixtures';
import type { FixtureFormat } from '../../../test/support/image-fixtures';
import { ImageRenditions } from './image-renditions';
import { MediaProcessingError, PORTFOLIO_RENDITIONS } from './media-processor.types';
import type { RenderedImage } from './media-processor.types';

const renderer = new ImageRenditions({ maxInputPixels: 24_000_000 });
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'image-renditions-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function render(
  bytes: Buffer,
  processor: ImageRenditions = renderer,
): Promise<readonly RenderedImage[]> {
  const inputPath = path.join(dir, 'raw');
  await writeFile(inputPath, bytes);
  return processor.renderImage({ inputPath, outputDir: dir, renditions: PORTFOLIO_RENDITIONS });
}

async function refusal(bytes: Buffer, processor?: ImageRenditions): Promise<string | undefined> {
  try {
    await render(bytes, processor);
  } catch (error) {
    if (error instanceof MediaProcessingError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

/** Red-ish at the top left and blue-ish at the bottom right: the marker is upright. */
async function isUpright(filePath: string): Promise<boolean> {
  const { data, info } = await sharp(filePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    return { r: data[i] ?? 0, b: data[i + 2] ?? 0 };
  };
  const topLeft = pixel(5, 5);
  const bottomRight = pixel(info.width - 5, info.height - 5);
  return (
    info.width > info.height &&
    topLeft.r > 200 &&
    topLeft.b < 60 &&
    bottomRight.b > 200 &&
    bottomRight.r < 60
  );
}

describe('ImageRenditions (issue #305)', () => {
  describe('a 12 MP geotagged JPEG', () => {
    it('becomes a 480 px thumb and a 1440 px display WebP, with no EXIF, GPS, XMP, IPTC or ICC left', async () => {
      const input = await geotaggedTwelveMegapixelJpeg();
      const inputMeta = await sharp(input).metadata();
      // The fixture carries what the output must not, or the test proves nothing.
      expect(inputMeta.width).toBe(4000);
      expect(inputMeta.height).toBe(3000);
      expect(inputMeta.exif && hasGpsIfd(inputMeta.exif)).toBe(true);
      expect(inputMeta.xmp).toBeDefined();

      const [thumb, display] = await render(input);

      expect(thumb).toMatchObject({ name: 'thumb', width: 480, height: 360 });
      expect(display).toMatchObject({ name: 'display', width: 1440, height: 1080 });
      for (const rendition of [thumb, display]) {
        const bytes = await readFile(rendition?.filePath ?? '');
        const meta = await sharp(bytes).metadata();
        expect(meta.format).toBe('webp');
        expect(rendition?.bytes).toBe(bytes.byteLength);
        expect(meta.exif).toBeUndefined();
        expect(meta.xmp).toBeUndefined();
        expect(meta.iptc).toBeUndefined();
        expect(meta.icc).toBeUndefined();
        // And not merely hidden from `metadata()`: the GPS reference value
        // is nowhere in the file.
        expect(bytes.includes(Buffer.from('40,24.6N'))).toBe(false);
        expect(bytes.includes(Buffer.from('xmpmeta'))).toBe(false);
      }
    });
  });

  describe('orientation', () => {
    it.each(
      (['jpeg', 'png', 'webp'] as const).flatMap((format) =>
        ([1, 3, 6, 8] as const).map((orientation) => [format, orientation] as const),
      ),
    )(
      'a %s tagged with orientation %i comes out upright and untagged',
      async (format: FixtureFormat, orientation) => {
        const input = await orientedPhoto(format, orientation);
        expect((await sharp(input).metadata()).orientation).toBe(orientation);

        const [thumb] = await render(input);

        expect(await isUpright(thumb?.filePath ?? '')).toBe(true);
        const meta = await sharp(thumb?.filePath).metadata();
        expect(meta.orientation).toBeUndefined();
        expect(meta.exif).toBeUndefined();
      },
    );
  });

  it('keeps a PNG’s transparency as a WebP with alpha', async () => {
    const [thumb] = await render(await transparentPng());

    const { data, info } = await sharp(thumb?.filePath).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
    expect(alphaAt(10, 100)).toBe(0);
    expect(alphaAt(190, 100)).toBe(255);
  });

  it('never enlarges an image smaller than the rendition', async () => {
    const [thumb, display] = await render(await solidImage('png', 320, 240));

    expect(thumb).toMatchObject({ width: 320, height: 240 });
    expect(display).toMatchObject({ width: 320, height: 240 });
  });

  it('reports a failure to write a rendition as the environment’s, not the image’s, so it is retried', async () => {
    const inputPath = path.join(dir, 'raw');
    await writeFile(inputPath, await solidImage('jpeg', 400, 300));

    const failure = renderer
      .renderImage({
        inputPath,
        outputDir: path.join(dir, 'does-not-exist'),
        renditions: PORTFOLIO_RENDITIONS,
      })
      .catch((error: unknown) => error);

    const error = await failure;
    expect(error).not.toBeInstanceOf(MediaProcessingError);
    expect((error as { code?: unknown }).code).toBe('ENOENT');
  });

  it('refuses an image just over the configured guard, which sharp’s own 268 MP default would let through', async () => {
    const guarded = new ImageRenditions({ maxInputPixels: 1_000_000 });

    expect(await refusal(await solidImage('png', 1001, 1000), guarded)).toBe('too_many_pixels');
    expect(await refusal(await solidImage('png', 1000, 1000), guarded)).toBeUndefined();
  });

  describe('refusals, each with a stable code', () => {
    it('refuses a decompression bomb from its header — a few hundred bytes declaring 2.5 GP', async () => {
      const bomb = pixelBombPng();
      expect(bomb.byteLength).toBeLessThan(1024);

      expect(await refusal(bomb)).toBe('too_many_pixels');
    });

    it('refuses a real image over MEDIA_MAX_INPUT_PIXELS', async () => {
      const strict = new ImageRenditions({ maxInputPixels: 1_000_000 });

      expect(await refusal(await solidImage('jpeg', 1200, 1000), strict)).toBe('too_many_pixels');
    });

    it('refuses a truncated JPEG rather than rendering half of it', async () => {
      const whole = await solidImage('jpeg', 800, 600);

      expect(await refusal(whole.subarray(0, Math.floor(whole.byteLength * 0.6)))).toBe(
        'undecodable',
      );
    });

    it('refuses bytes that claim to be a PNG and are not one', async () => {
      const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      expect(await refusal(Buffer.concat([header, Buffer.alloc(200, 0x41)]))).toBe('undecodable');
    });

    it('refuses an HEIC photo with its own code, before the decoder sees it', async () => {
      const heic = Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from('ftypheic', 'ascii'),
        Buffer.alloc(100),
      ]);

      expect(await refusal(heic)).toBe('heic_unsupported');
    });

    it.each([
      [
        'an SVG, which sharp would otherwise rasterise',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
      ],
      ['a GIF', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')],
      ['random bytes', Buffer.from('not an image at all')],
    ])('refuses %s as unsupported', async (_label, bytes) => {
      expect(await refusal(bytes)).toBe('unsupported_format');
    });
  });
});
