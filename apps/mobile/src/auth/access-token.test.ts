import { readAccessTokenIdentity } from './access-token';

/**
 * Builds a token the way the server does — `header.payload.signature`, each
 * segment base64url — so the decoder is exercised against the real encoding
 * rather than against a string shaped to suit it.
 *
 * The signature is nonsense on purpose: nothing on the client verifies it, and
 * a test that used a real one would suggest otherwise.
 */
function accessTokenWith(claims: Record<string, unknown>): string {
  const segment = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  return `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment(claims)}.not-a-signature`;
}

describe('reading an access token', () => {
  it('reports the user id and the roles the token claims', () => {
    const token = accessTokenWith({ sub: 'user-1', roles: ['customer'], sid: 'session-1' });

    expect(readAccessTokenIdentity(token)).toEqual({ userId: 'user-1', roles: ['customer'] });
  });

  it('reports both roles for a user who holds both', () => {
    const token = accessTokenWith({ sub: 'user-1', roles: ['master', 'customer'] });

    const identity = readAccessTokenIdentity(token);

    expect(identity?.roles).toEqual(['customer', 'master']);
  });

  it('ignores a role this app has no screens for', () => {
    const token = accessTokenWith({ sub: 'user-1', roles: ['customer', 'moderator'] });

    expect(readAccessTokenIdentity(token)?.roles).toEqual(['customer']);
  });

  it('decodes a payload whose base64url encoding needs padding', () => {
    // A 1-character difference in payload length changes how many `=` the
    // encoder would have added, which is the case a naive decoder gets wrong.
    for (const suffix of ['a', 'ab', 'abc', 'abcd']) {
      const token = accessTokenWith({ sub: `user-${suffix}`, roles: ['customer'] });

      expect(readAccessTokenIdentity(token)?.userId).toBe(`user-${suffix}`);
    }
  });

  it('reports no roles when the claim is missing, rather than inventing one', () => {
    const token = accessTokenWith({ sub: 'user-1' });

    expect(readAccessTokenIdentity(token)).toEqual({ userId: 'user-1', roles: [] });
  });

  it('reports no user id when the claim is not a string', () => {
    const token = accessTokenWith({ sub: 42, roles: ['customer'] });

    expect(readAccessTokenIdentity(token)?.userId).toBeNull();
  });

  it('refuses a string that is not three segments', () => {
    expect(readAccessTokenIdentity('not.a-token')).toBeNull();
    expect(readAccessTokenIdentity('')).toBeNull();
  });

  it('refuses a payload that is not base64url', () => {
    expect(readAccessTokenIdentity('header.$$$$.signature')).toBeNull();
  });

  it('refuses a payload that is not JSON', () => {
    const payload = Buffer.from('definitely not json').toString('base64url');

    expect(readAccessTokenIdentity(`header.${payload}.signature`)).toBeNull();
  });

  it('refuses a payload that is JSON but not an object', () => {
    const payload = Buffer.from(JSON.stringify('a string')).toString('base64url');

    expect(readAccessTokenIdentity(`header.${payload}.signature`)).toBeNull();
  });
});
