import { describe, expect, it } from 'vitest';

import {
  IMAGE_SIGNATURE_BYTES,
  isAllowedImageContentType,
  sniffImageContentType,
} from './image-content-type';

/**
 * These are the whole control behind "a declared `Content-Type` is a claim,
 * not a fact" — `master-verification.service.ts` trusts nothing except what
 * this function reports about the leading bytes. A sniffer that guesses when
 * it is unsure, or that recognises a container without checking what is
 * inside it, would quietly turn every check built on top of it into a no-op.
 */

function bytes(values: readonly number[]): Uint8Array {
  return Uint8Array.from(values);
}

/** Pads a signature out to at least `length` bytes with trailing zeros. */
function padded(signature: readonly number[], length = IMAGE_SIGNATURE_BYTES): Uint8Array {
  const buffer = new Uint8Array(Math.max(length, signature.length));
  buffer.set(signature);
  return buffer;
}

const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0];
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
const WAVE_TAG = [0x57, 0x41, 0x56, 0x45]; // "WAVE"

describe('sniffImageContentType', () => {
  it('recognises a real JPEG signature', () => {
    expect(sniffImageContentType(padded(JPEG_BYTES))).toBe('image/jpeg');
  });

  it('recognises JPEG variants that differ only in the fourth marker byte', () => {
    // The fourth byte legitimately varies between JFIF (0xE0), Exif (0xE1),
    // and other markers (0xDB, 0xEE, ...) — only the first three bytes are
    // the actual signature.
    for (const fourthByte of [0xe1, 0xdb, 0xee]) {
      expect(sniffImageContentType(padded([0xff, 0xd8, 0xff, fourthByte]))).toBe('image/jpeg');
    }
  });

  it('recognises a real PNG signature', () => {
    expect(sniffImageContentType(padded(PNG_BYTES))).toBe('image/png');
  });

  it('recognises a real WebP signature — a RIFF container tagged WEBP', () => {
    // RIFF header, four size bytes (arbitrary — the sniffer does not read
    // them), then the format tag at offset 8.
    const riffWebp = [...RIFF, 0x00, 0x00, 0x00, 0x00, ...WEBP_TAG];
    expect(sniffImageContentType(padded(riffWebp))).toBe('image/webp');
  });

  it('rejects a RIFF container that is not WebP — a WAV file is also RIFF', () => {
    // The trap this guards: matching on the four-byte "RIFF" magic alone
    // would accept any RIFF-based format, audio included. Only the format
    // tag at offset 8 distinguishes a picture from a sound file.
    const riffWave = [...RIFF, 0x00, 0x00, 0x00, 0x00, ...WAVE_TAG];
    expect(sniffImageContentType(padded(riffWave))).toBeNull();
  });

  it('rejects truncated input that stops mid-signature', () => {
    // A prefix that starts exactly like a PNG but runs out before the
    // signature completes must not be accepted on the strength of the bytes
    // it does have.
    expect(sniffImageContentType(bytes(PNG_BYTES.slice(0, 4)))).toBeNull();
    expect(sniffImageContentType(bytes([0xff, 0xd8]))).toBeNull();
    // A RIFF header with nothing after it — no format tag to check at all.
    expect(sniffImageContentType(bytes(RIFF))).toBeNull();
  });

  it('rejects empty input', () => {
    expect(sniffImageContentType(bytes([]))).toBeNull();
  });

  it('rejects the byte prefix of an SVG, HTML, and PDF document', () => {
    const svgPrefix = bytes([...Buffer.from('<svg xmlns="http', 'utf8')].slice(0, 12));
    const htmlPrefix = bytes([...Buffer.from('<!DOCTYPE htm', 'utf8')]);
    const pdfPrefix = bytes([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"

    expect(sniffImageContentType(svgPrefix)).toBeNull();
    expect(sniffImageContentType(htmlPrefix)).toBeNull();
    expect(sniffImageContentType(pdfPrefix)).toBeNull();
  });

  it('never needs more than IMAGE_SIGNATURE_BYTES to decide any case above', () => {
    // The service reads exactly this many bytes from storage
    // (`readPrefix(key, IMAGE_SIGNATURE_BYTES)`) and trusts the result — if a
    // real signature needed more bytes than this constant provides, every
    // confirm would silently sniff a truncated, and therefore wrong, prefix.
    const riffWebp = padded([...RIFF, 0x00, 0x00, 0x00, 0x00, ...WEBP_TAG]);
    expect(riffWebp.byteLength).toBeLessThanOrEqual(IMAGE_SIGNATURE_BYTES);
    expect(sniffImageContentType(riffWebp.slice(0, IMAGE_SIGNATURE_BYTES))).toBe('image/webp');
  });
});

describe('isAllowedImageContentType', () => {
  it('accepts exactly the three formats the sniffer recognises', () => {
    expect(isAllowedImageContentType('image/jpeg')).toBe(true);
    expect(isAllowedImageContentType('image/png')).toBe(true);
    expect(isAllowedImageContentType('image/webp')).toBe(true);
  });

  it('rejects everything else, including formats that sound like images', () => {
    // SVG in particular: it is a document format with script in it, not a
    // picture, and permanently excluded (`image-content-type.ts` comment).
    for (const value of ['image/gif', 'image/svg+xml', 'application/pdf', 'text/html', '']) {
      expect(isAllowedImageContentType(value)).toBe(false);
    }
  });
});
