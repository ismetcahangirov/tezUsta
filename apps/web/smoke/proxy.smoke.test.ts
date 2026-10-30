import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The page and the API through the page's production proxy (ADR-0061 § 1),
 * over real HTTP: its headers and caching, the SPA fallback that the
 * provider's return relies on, the API's JSON under `/api`, and the web
 * sign-in's refusals with the cookies' attributes as a browser receives them.
 *
 * A whole web session needs a master and the code texted to them, which the
 * API's own suite covers (`apps/api/test/web-auth.e2e.test.ts`); this checks
 * what only the proxy can break.
 *
 * Not part of `pnpm test`: it needs the proxy and the API running. CI's "Web
 * page proxy smoke" job starts both.
 *
 *   SMOKE_BASE_URL    the proxy, e.g. http://127.0.0.1:8081
 */
const BASE = process.env.SMOKE_BASE_URL ?? '';
const CSRF = { 'x-tezusta-web': '1' } as const;

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function get(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, { redirect: 'manual', ...init });
}

function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function expectPageHeaders(res: Response): void {
  expect(res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
  // Public, unlike the admin panel: nothing tells a crawler to stay away.
  expect(res.headers.get('x-robots-tag')).toBeNull();
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
}

describe('the web subscription page through its production proxy (ADR-0061)', () => {
  beforeAll(() => {
    if (BASE === '') {
      throw new Error('Set SMOKE_BASE_URL — see the comment above.');
    }
  });

  describe('the page', () => {
    it('serves index.html at / with the security headers, revalidated on every load', async () => {
      const res = await get('/');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expectPageHeaders(res);
      const html = await res.text();
      expect(html).toContain('<div id="root"></div>');
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(html).not.toMatch(/noindex/);
    });

    it('answers the provider’s return address with the page', async () => {
      const res = await get('/return?ref=anything');
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<div id="root"></div>');
      expectPageHeaders(res);
    });

    it('caches a hashed asset for a year, answers 404 for a missing one, and ships no source map', async () => {
      const html = await (await get('/')).text();
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      expect(script).toBeDefined();
      const asset = await get(script ?? '');
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expectPageHeaders(asset);

      const missing = await get('/assets/does-not-exist.js');
      expect(missing.status).toBe(404);
      expect(missing.headers.get('cache-control') ?? '').not.toContain('immutable');

      expect((await get(`${script ?? ''}.map`)).status).toBe(404);
    });
  });

  describe('the API under /api', () => {
    it('answers an unknown path with its JSON 404 and its own headers, never the page', async () => {
      for (const path of ['/api/does-not-exist', '/api']) {
        const res = await get(path);
        expect(res.status, path).toBe(404);
        expect(res.headers.get('content-type'), path).toMatch(/^application\/json/);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code, path).toBe('NOT_FOUND');
        expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      }
    });
  });

  describe('the web sign-in over the proxy', () => {
    it('answers a code request for an address that is nobody’s exactly as for any other', async () => {
      const res = await postJson('/api/web/auth/otp/request', { email: 'nobody@example.com' });
      expect(res.status).toBe(200);
      expect(Object.keys((await res.json()) as object)).toEqual(['expiresInSeconds']);
    });

    it('refuses a verify without the CSRF header', async () => {
      const res = await postJson('/api/web/auth/otp/verify', {
        email: 'nobody@example.com',
        code: '123456',
      });
      expect(res.status).toBe(403);
    });

    it('refuses a refresh with a dead cookie, and clears both cookies with hardened attributes', async () => {
      const res = await postJson(
        '/api/web/auth/refresh',
        {},
        { ...CSRF, cookie: 'tz_web_rt=dead' },
      );
      expect(res.status).toBe(401);
      const cookies = res.headers
        .getSetCookie()
        .map((line) => line.split(';').map((p) => p.trim()));
      expect(cookies.map(([pair]) => pair)).toEqual(['tz_web_at=', 'tz_web_rt=']);
      for (const attributes of cookies) {
        expect(attributes).toEqual(
          expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=0']),
        );
      }
    });

    it('lets no web cookie reach a route outside the subscription', async () => {
      const res = await get('/api/customers/me', {
        headers: { ...CSRF, cookie: 'tz_web_at=not-a-token' },
      });
      expect(res.status).toBe(401);
    });
  });
});
