/**
 * The CDN boundary ([ADR-0045](docs/decisions/ADR-0045-master-portfolio.md)
 * § 5–6).
 *
 * A public rendition is served with a year-long immutable `Cache-Control`, so
 * deleting its object does not take it off the CDN. Every deletion — a
 * master's own, an account deletion, an admin removal — therefore deletes the
 * objects and then purges their URLs.
 *
 * One method, by URL. Purging by prefix or tag would need an Enterprise plan
 * on Cloudflare, and purging a whole zone would throw away every other
 * master's cached photos to remove one master's.
 *
 * No vendor type crosses this boundary, for the reason `StorageProvider`
 * keeps none: the move to `packages/config` (ADR-0016) stays a file move.
 */
export interface CdnPurger {
  /**
   * Removes these URLs from the CDN cache. Idempotent — purging a URL that is
   * not cached is not an error — so a sweep that failed half-way purges the
   * whole list again. Throws {@link CdnPurgeFailedError} when the CDN did not
   * accept the request; the caller retries, because until it succeeds a
   * deleted photo is still being served.
   */
  purgeUrls(urls: readonly string[]): Promise<void>;
}

/**
 * The CDN did not accept a purge.
 *
 * The message carries the HTTP status and the provider's error codes, and
 * never the request: the request carries the API token in its headers and
 * the URLs of photos someone deleted in its body.
 */
export class CdnPurgeFailedError extends Error {
  constructor(reason: string) {
    super(`The CDN purge failed: ${reason}`);
    this.name = 'CdnPurgeFailedError';
    Object.setPrototypeOf(this, CdnPurgeFailedError.prototype);
  }
}

/** DI token for {@link CdnPurger}; an interface cannot be injected by its own type. */
export const CDN_PURGER = Symbol('CDN_PURGER');
