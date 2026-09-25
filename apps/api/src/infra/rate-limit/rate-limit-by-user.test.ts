import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { rateLimitByUser } from './rate-limit-by-user';

function withAuthorization(authorization: string | undefined): FastifyRequest {
  return { headers: authorization === undefined ? {} : { authorization } } as FastifyRequest;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('rateLimitByUser (issue #271)', () => {
  it('names the bucket after the subject the verifier vouches for', () => {
    const verify = vi.fn((token: string) => (token === 'good-token' ? 'user-a' : undefined));

    expect(rateLimitByUser(withAuthorization('Bearer good-token'), verify)).toBe('user-a');
    expect(verify).toHaveBeenCalledWith('good-token');
  });

  it('never falls back to the claimed sub when the verifier refuses the token', () => {
    // A well-formed token naming a victim, which is exactly what the old
    // implementation decoded and trusted.
    const forged = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'victim' })}.sig`;
    const verify = vi.fn(() => undefined);

    expect(rateLimitByUser(withAuthorization(`Bearer ${forged}`), verify)).toBeUndefined();
    expect(verify).toHaveBeenCalledWith(forged);
  });

  it.each([
    ['no Authorization header', undefined],
    ['a scheme other than Bearer', 'Basic dXNlcjpwYXNz'],
    ['an empty token', 'Bearer '],
    ['more than one space-separated part', 'Bearer a b'],
    ['a bare token with no scheme', 'eyJhbGciOiJIUzI1NiJ9.e30.sig'],
  ])('carries no identifier for %s, without consulting the verifier', (_label, header) => {
    const verify = vi.fn(() => 'user-a');

    expect(rateLimitByUser(withAuthorization(header), verify)).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });
});
