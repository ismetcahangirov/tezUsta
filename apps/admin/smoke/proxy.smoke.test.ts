import { createHmac } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The panel and the API through the production proxy (#331, ADR-0052), over
 * real HTTP: the panel's headers and caching, the SPA fallback, the API's JSON
 * 404 under `/api`, and a whole admin session — setup, sign-in, refresh,
 * sign-out — with the cookies' attributes as the browser would receive them.
 *
 * Not part of `pnpm test`: it needs the proxy and the API running. CI's
 * "Admin proxy" job starts both; locally, see
 * `docs/engineering/admin-bootstrap.md` § A production-like run.
 *
 *   SMOKE_BASE_URL    the proxy, e.g. http://127.0.0.1:8080
 *   SMOKE_SETUP_LINK  a fresh setup link from `admin:bootstrap`, never used
 */
const BASE = process.env.SMOKE_BASE_URL ?? '';
const SETUP_LINK = process.env.SMOKE_SETUP_LINK ?? '';
const CSRF = { 'x-tezusta-admin': '1' } as const;

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** RFC 4648 base32, as the setup page shows the key. */
function base32Decode(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of value.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error(`Not base32: ${character}`);
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

/** RFC 6238 with the panel's parameters: SHA-1, 30 seconds, six digits. */
function totp(secret: Buffer, stepOffset = 0): string {
  const step = Math.floor(Date.now() / 30_000) + stepOffset;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

interface Cookie {
  readonly name: string;
  readonly value: string;
  readonly attributes: readonly string[];
}

function cookiesOf(res: Response): Cookie[] {
  return res.headers.getSetCookie().map((line) => {
    const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
    const [name = '', ...value] = pair.split('=');
    return { name, value: value.join('='), attributes };
  });
}

function cookieHeader(cookies: readonly Cookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

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

function expectPanelHeaders(res: Response): void {
  expect(res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
  expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
}

describe('the admin panel through its production proxy (#331)', () => {
  beforeAll(() => {
    if (BASE === '' || SETUP_LINK === '') {
      throw new Error('Set SMOKE_BASE_URL and SMOKE_SETUP_LINK — see the comment above.');
    }
  });

  describe('the panel', () => {
    it('serves index.html at / with the security headers, revalidated on every load', async () => {
      const res = await get('/');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expectPanelHeaders(res);
      const html = await res.text();
      expect(html).toContain('<div id="root"></div>');
      // No inline script for the CSP to refuse: every <script> has a src.
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    });

    it('answers a deep link with the panel, so a reload stays on the page', async () => {
      const res = await get('/customers/0b9e7d1c-0000-4000-8000-000000000001');
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<div id="root"></div>');
      expectPanelHeaders(res);
    });

    it('caches a hashed asset for a year, and answers 404 — not the panel — for a missing one', async () => {
      const html = await (await get('/')).text();
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      expect(script).toBeDefined();
      const asset = await get(script ?? '');
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expectPanelHeaders(asset);

      const missing = await get('/assets/does-not-exist.js');
      expect(missing.status).toBe(404);
      // A 404 cached for a year would outlive the deploy that caused it.
      expect(missing.headers.get('cache-control') ?? '').not.toContain('immutable');
      expect(await missing.text()).not.toContain('<div id="root"></div>');
    });

    it('ships no source map', async () => {
      const html = await (await get('/')).text();
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? '';
      expect((await get(`${script}.map`)).status).toBe(404);
    });
  });

  describe('the API under /api', () => {
    it('answers an unknown path with its JSON 404, never the panel', async () => {
      for (const path of ['/api/does-not-exist', '/api']) {
        const res = await get(path);
        expect(res.status, path).toBe(404);
        expect(res.headers.get('content-type'), path).toMatch(/^application\/json/);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code, path).toBe('NOT_FOUND');
      }
    });

    it('keeps the API’s own security headers', async () => {
      const res = await get('/api/does-not-exist');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    });
  });

  describe('an admin session over the proxy', () => {
    it('sets up, signs in, refreshes and signs out, with hardened cookies on the right path', async () => {
      const token = new URL(SETUP_LINK).hash.slice(1);
      const started = await postJson('/api/admin/auth/setup/start', { token });
      expect(started.status).toBe(200);
      const offer = (await started.json()) as {
        email: string;
        totpSecret: string;
        enrolment: string;
      };
      const secret = base32Decode(offer.totpSecret);
      const password = 'a smoke-test passphrase';

      const completed = await postJson('/api/admin/auth/setup/complete', {
        token,
        password,
        enrolment: offer.enrolment,
        code: totp(secret),
      });
      expect(completed.status).toBe(204);

      // The next step: the setup just spent this one.
      const signedIn = await postJson(
        '/api/admin/auth/sign-in',
        { email: offer.email, password, code: totp(secret, 1) },
        CSRF,
      );
      expect(signedIn.status).toBe(200);
      const cookies = cookiesOf(signedIn);
      expect(cookies).toHaveLength(2);
      for (const cookie of cookies) {
        expect(cookie.attributes, cookie.name).toEqual(
          expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']),
        );
      }

      const me = await get('/api/admin/me', {
        headers: { ...CSRF, cookie: cookieHeader(cookies) },
      });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { email: string }).email).toBe(offer.email);

      const refreshed = await fetch(`${BASE}/api/admin/auth/refresh`, {
        method: 'POST',
        headers: { ...CSRF, cookie: cookieHeader(cookies) },
      });
      expect(refreshed.status).toBe(200);
      const rotated = cookiesOf(refreshed);
      expect(rotated).toHaveLength(2);

      const signedOut = await fetch(`${BASE}/api/admin/auth/sign-out`, {
        method: 'POST',
        headers: { ...CSRF, cookie: cookieHeader(rotated) },
      });
      expect(signedOut.status).toBe(204);
      const after = await get('/api/admin/me', {
        headers: { ...CSRF, cookie: cookieHeader(rotated) },
      });
      expect(after.status).toBe(401);
    });
  });
});
