/**
 * What an uploaded image is actually allowed to be, and how to tell.
 *
 * Two separate controls live here, and conflating them is the bug this file
 * exists to prevent:
 *
 * 1. **The allow-list** — the set of content types a client may even ask to
 *    upload. An allow-list fails closed; a deny-list does not
 *    ([ADR-0005](docs/decisions/ADR-0005-object-storage.md)).
 * 2. **The sniff** — what the stored bytes say they are. A declared
 *    `Content-Type` is a client assertion, not a fact, and an attacker who
 *    wants to store an HTML page or a script in a bucket that serves it back
 *    will declare `image/png` without hesitating.
 *
 * A file passes only when both agree.
 */

/**
 * The three formats a phone camera produces and every client can render.
 *
 * No SVG, deliberately and permanently: SVG is a document format with script
 * in it, not a picture, and a bucket that will hand one back to a browser has
 * a stored-XSS vector that no amount of sniffing detects — a malicious SVG is
 * a *valid* SVG.
 */
export const ALLOWED_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type AllowedImageContentType = (typeof ALLOWED_IMAGE_CONTENT_TYPES)[number];

export function isAllowedImageContentType(value: string): value is AllowedImageContentType {
  return (ALLOWED_IMAGE_CONTENT_TYPES as readonly string[]).includes(value);
}

/**
 * How many leading bytes {@link sniffImageContentType} needs.
 *
 * Twelve: WebP is the longest signature to confirm, because it is a RIFF
 * container whose format tag sits at offset 8.
 */
export const IMAGE_SIGNATURE_BYTES = 12;

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP"

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * What the bytes actually are, or `null` for anything not on the allow-list.
 *
 * Returning `null` rather than a best guess is the point: this is the check
 * that decides whether an object survives, so "I could not identify it" and
 * "it is not an image we accept" must produce the same outcome. A sniffer that
 * falls back to the declared type when it cannot recognise something has
 * quietly become a no-op.
 *
 * JPEG is matched on `FF D8 FF` rather than the full `FF D8 FF E0` of a JFIF
 * file, because the fourth byte is the first marker and legitimately varies
 * (`E0` JFIF, `E1` Exif, `DB`, `EE` …). Every JPEG starts with the first
 * three; nothing else does.
 */
export function sniffImageContentType(bytes: Uint8Array): AllowedImageContentType | null {
  if (startsWith(bytes, JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return 'image/png';
  }
  // RIFF alone is not enough — a WAV file is also a RIFF container. The
  // format tag at offset 8 is what separates a picture from audio.
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_TAG, 8)) {
    return 'image/webp';
  }
  return null;
}
