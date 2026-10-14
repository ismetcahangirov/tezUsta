import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { CdnPurgeFailedError } from './cdn-purger.types';
import { CloudflareCdnPurger } from './cloudflare-cdn-purger';

const ZONE_ID = '0123456789abcdef0123456789abcdef';
const TOKEN = 'purge-only-token-that-must-never-be-logged';

let fetchMock: MockInstance<typeof fetch>;

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function purger(): CloudflareCdnPurger {
  return new CloudflareCdnPurger({ zoneId: ZONE_ID, apiToken: TOKEN });
}

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CloudflareCdnPurger (issue #304)', () => {
  it('POSTs the URLs to the zone purge endpoint with the bearer token', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true, errors: [], result: { id: ZONE_ID } }));

    await purger().purgeUrls([
      'https://media.example.com/portfolio/a/thumb.webp',
      'https://media.example.com/portfolio/a/display.webp',
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      files: [
        'https://media.example.com/portfolio/a/thumb.webp',
        'https://media.example.com/portfolio/a/display.webp',
      ],
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('splits a long list into requests of at most 100 URLs — the Free/Pro/Business ceiling', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(reply(200, { success: true })));
    const urls = Array.from({ length: 201 }, (_, i) => `https://media.example.com/p/${String(i)}`);

    await purger().purgeUrls(urls);

    const sizes = fetchMock.mock.calls.map(
      ([, init]) => (JSON.parse(init?.body as string) as { files: string[] }).files.length,
    );
    expect(sizes).toEqual([100, 100, 1]);
  });

  it('removes duplicates, and sends nothing for an empty list', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(reply(200, { success: true })));

    await purger().purgeUrls([]);
    expect(fetchMock).not.toHaveBeenCalled();

    await purger().purgeUrls(['https://m.example.com/a', 'https://m.example.com/a']);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { files: string[] };
    expect(body.files).toEqual(['https://m.example.com/a']);
  });

  it('fails on a 200 that says success: false, naming Cloudflare’s error code', async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        success: false,
        errors: [
          { code: 1012, message: 'Request must contain one of "purge_everything" or "files"' },
        ],
      }),
    );

    await expect(purger().purgeUrls(['https://m.example.com/a'])).rejects.toThrow(
      /HTTP 200, Cloudflare error 1012/,
    );
  });

  it('fails on a refused token', async () => {
    fetchMock.mockResolvedValue(
      reply(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }),
    );

    await expect(purger().purgeUrls(['https://m.example.com/a'])).rejects.toThrow(
      CdnPurgeFailedError,
    );
  });

  it('fails on a 5xx with no JSON body', async () => {
    fetchMock.mockResolvedValue(reply(502, '<html>Bad gateway</html>'));

    await expect(purger().purgeUrls(['https://m.example.com/a'])).rejects.toThrow(/HTTP 502/);
  });

  it('fails on a network error without echoing the request, which carries the token', async () => {
    fetchMock.mockRejectedValue(new TypeError(`fetch failed: Bearer ${TOKEN}`));

    const failure = purger().purgeUrls(['https://m.example.com/a']);

    await expect(failure).rejects.toThrow(CdnPurgeFailedError);
    await failure.catch((error: unknown) => {
      expect(String(error)).not.toContain(TOKEN);
      expect((error as Error).cause).toBeUndefined();
    });
  });

  it('stops at the first failed batch, so the caller retries the whole list', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, { success: true }))
      .mockResolvedValueOnce(reply(429, { success: false, errors: [{ code: 971 }] }));
    const urls = Array.from({ length: 300 }, (_, i) => `https://media.example.com/p/${String(i)}`);

    await expect(purger().purgeUrls(urls)).rejects.toThrow(/HTTP 429/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
