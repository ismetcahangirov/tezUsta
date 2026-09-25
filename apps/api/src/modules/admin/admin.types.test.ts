import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { isAdminRequest, isAdminRoutePattern, matchedRoutePattern } from './admin.types';

/**
 * The classifier every admin and consumer guard asks first. The HTTP-level
 * proof — every admin route, every spelling, through the real router — is in
 * `test/admin-verification.e2e.test.ts`; this pins the rule itself, including
 * the inputs a real request never produces (a double without `routeOptions`,
 * a socket without `url`).
 */
function requestWith(url: unknown, routePattern?: string): FastifyRequest {
  return (routePattern === undefined
    ? { url }
    : { url, routeOptions: { url: routePattern } }) as unknown as FastifyRequest;
}

describe('isAdminRequest', () => {
  describe('from the matched route pattern', () => {
    it('is admin when the router matched a route under /admin, whatever the client sent (#269)', () => {
      expect(isAdminRequest(requestWith('/%61dmin/orders', '/admin/orders'))).toBe(true);
      expect(isAdminRequest(requestWith('/adm%69n/masters/x', '/admin/masters/:id'))).toBe(true);
      expect(isAdminRequest(requestWith('/admin', '/admin'))).toBe(true);
    });

    it('is not admin for a consumer route', () => {
      expect(isAdminRequest(requestWith('/orders/abc', '/orders/:id'))).toBe(false);
    });

    it('does not treat /adminx as under /admin', () => {
      expect(isAdminRequest(requestWith('/adminx', '/adminx'))).toBe(false);
    });
  });

  describe('from the URL, when no route pattern is available', () => {
    it.each([
      ['/admin', true],
      ['/admin/', true],
      ['/admin/orders', true],
      ['/admin?x=1', true],
      ['/%61dmin/orders', true],
      ['/adm%69n', true],
      ['/%61%64%6d%69%6e/orders', true],
      ['/adminx', false],
      ['/adminx?foo=/admin', false],
      ['/orders?next=/admin/orders', false],
      ['/', false],
      ['', false],
      ['/%E0%A4%A', false],
    ])('%s → %s', (url, expected) => {
      expect(isAdminRequest(requestWith(url))).toBe(expected);
    });

    it('is not admin when there is no url at all — a socket, or a bare double', () => {
      expect(isAdminRequest(requestWith(undefined))).toBe(false);
      expect(isAdminRequest({} as FastifyRequest)).toBe(false);
    });
  });

  it('is admin if either signal says so — a disagreement fails towards the admin guards', () => {
    expect(isAdminRequest(requestWith('/admin/orders', '/orders'))).toBe(true);
  });
});

describe('matchedRoutePattern / isAdminRoutePattern', () => {
  it('reads the pattern and nothing else', () => {
    expect(matchedRoutePattern(requestWith('/admin/orders'))).toBeUndefined();
    expect(isAdminRoutePattern(requestWith('/admin/orders'))).toBe(false);
    expect(matchedRoutePattern(requestWith('/x', '/admin/orders/:id'))).toBe('/admin/orders/:id');
    expect(isAdminRoutePattern(requestWith('/x', '/admin/orders/:id'))).toBe(true);
  });

  it('treats a missing or empty pattern as no match', () => {
    const empty = { url: '/x', routeOptions: { url: '' } } as unknown as FastifyRequest;
    const bare = { url: '/x', routeOptions: {} } as unknown as FastifyRequest;
    expect(matchedRoutePattern(empty)).toBeUndefined();
    expect(matchedRoutePattern(bare)).toBeUndefined();
  });
});
