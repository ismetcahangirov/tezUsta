/**
 * The unsigned URL of a public object: `MEDIA_PUBLIC_BASE_URL` followed by the
 * key, one percent-encoded segment at a time.
 *
 * Shared by both providers so that the stub hands out URLs of exactly the
 * shape production does, and a test asserting on one is asserting on the
 * other.
 *
 * Keys are server-generated (ADR-0045 § 5), so a malformed one is a bug in the
 * caller, not input to tolerate. A leading slash, an empty segment or a `.` /
 * `..` segment would each produce a URL that a CDN or a browser normalises to
 * a different path than the object's key, and the object would be unreachable
 * at the URL the response named — or, worse, another object would answer it.
 * Refusing is the only behaviour that cannot hand out a wrong URL.
 */
export function buildPublicUrl(baseUrl: string, key: string): string {
  assertPublicKey(key);
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The same rule, applied where an object is written or deleted. A rendition
 * written under a key `publicUrl` refuses would be public with no URL to name
 * it and none to purge it by, so `putPublic` refuses it before a byte is
 * public.
 */
export function assertPublicKey(key: string): void {
  if (key.length === 0 || key.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new InvalidPublicKeyError();
  }
}

/** The key is not named in the message; whoever logs this learns nothing about it. */
export class InvalidPublicKeyError extends Error {
  constructor() {
    super(
      'A public media key must be non-empty, relative, and free of empty, "." or ".." segments.',
    );
    this.name = 'InvalidPublicKeyError';
    Object.setPrototypeOf(this, InvalidPublicKeyError.prototype);
  }
}
