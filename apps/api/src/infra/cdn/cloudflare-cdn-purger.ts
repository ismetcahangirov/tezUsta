import { CdnPurgeFailedError } from './cdn-purger.types';
import type { CdnPurger } from './cdn-purger.types';

const API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Cloudflare's per-request ceiling on purge-by-URL for the Free, Pro and
 * Business plans (Enterprise allows 500). Sized for the smallest plan so that
 * no plan change on the owner's side can turn a sweep into a stream of
 * rejected requests. Source:
 * https://developers.cloudflare.com/cache/how-to/purge-cache/#single-file-purge-limits
 */
export const CLOUDFLARE_PURGE_BATCH_SIZE = 100;

/**
 * Long enough for Cloudflare's API on a bad day; short enough that a sweep
 * stuck on it gives its worker back rather than holding it.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export interface CloudflareCdnPurgerConfig {
  readonly zoneId: string;
  /** Zone → Cache Purge on this one zone, nothing more. */
  readonly apiToken: string;
}

interface CloudflareResponse {
  readonly success?: unknown;
  readonly errors?: unknown;
}

/**
 * Purge by URL through Cloudflare's API:
 * `POST /zones/{zone_id}/purge_cache` with `{ "files": [...] }`
 * (https://developers.cloudflare.com/api/resources/cache/methods/purge/).
 *
 * The URLs are the ones `StorageProvider.publicUrl` built on
 * `MEDIA_PUBLIC_BASE_URL`, which is a hostname in this zone — a purge names
 * the URL as the cache keyed it, so it must be the same string a phone
 * fetched.
 *
 * Plain `fetch`, as `GoogleGeocodingProvider` uses: one endpoint, one verb,
 * and Cloudflare's SDK would be a dependency carried for a single call.
 */
export class CloudflareCdnPurger implements CdnPurger {
  constructor(private readonly config: CloudflareCdnPurgerConfig) {}

  async purgeUrls(urls: readonly string[]): Promise<void> {
    const unique = [...new Set(urls)];
    for (let start = 0; start < unique.length; start += CLOUDFLARE_PURGE_BATCH_SIZE) {
      await this.purgeBatch(unique.slice(start, start + CLOUDFLARE_PURGE_BATCH_SIZE));
    }
  }

  private async purgeBatch(files: readonly string[]): Promise<void> {
    let response: Response;
    try {
      response = await fetch(
        `${API_BASE}/zones/${encodeURIComponent(this.config.zoneId)}/purge_cache`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.apiToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ files }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch {
      // The cause is not attached: a fetch error can carry the request, and
      // the request carries the token.
      throw new CdnPurgeFailedError('the request failed or timed out');
    }

    let body: CloudflareResponse | undefined;
    try {
      body = (await response.json()) as CloudflareResponse;
    } catch {
      body = undefined;
    }

    // Both checks, because each can be true alone: Cloudflare answers some
    // refusals with a 200 and `success: false`, and a proxy in the way can
    // answer a 5xx with no JSON at all.
    if (!response.ok || body?.success !== true) {
      throw new CdnPurgeFailedError(
        `HTTP ${String(response.status)}${describeErrors(body?.errors)}`,
      );
    }
  }
}

/** Cloudflare's numeric error codes, which say what went wrong without echoing input. */
function describeErrors(errors: unknown): string {
  if (!Array.isArray(errors)) {
    return '';
  }
  const codes = errors
    .map((error: unknown) =>
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined,
    )
    .filter((code): code is number => typeof code === 'number');
  return codes.length > 0 ? `, Cloudflare error ${codes.join(', ')}` : '';
}
