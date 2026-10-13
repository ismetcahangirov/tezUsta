import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  createFastifyAdapter,
  createFastifyAdapterOptions,
  DEFAULT_BODY_LIMIT_BYTES,
} from './fastify-adapter-options';
import type { SafeTrustProxyOption } from './fastify-adapter-options';

describe('createFastifyAdapterOptions (issue #275)', () => {
  it('sets the reviewed 1 MiB body limit by default', () => {
    const options = createFastifyAdapterOptions();

    expect(options.bodyLimit).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(options.bodyLimit).toBe(1024 * 1024);
  });

  it('defaults trustProxy to false, matching the socket-peer IP the rate limiter relies on', () => {
    const options = createFastifyAdapterOptions();

    expect(options.trustProxy).toBe(false);
  });

  it('accepts an explicit proxy address once one is configured', () => {
    const options = createFastifyAdapterOptions({ trustProxy: '10.0.0.1' });

    expect(options.trustProxy).toBe('10.0.0.1');
  });

  it('accepts an explicit CIDR list', () => {
    const options = createFastifyAdapterOptions({ trustProxy: ['10.0.0.0/8', '172.16.0.0/12'] });

    expect(options.trustProxy).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
  });

  it('refuses trustProxy: true even when a caller routes around the type system', () => {
    // The exported type excludes `true`, so this simulates a caller that
    // reached it from `unknown` — a parsed env var, or a future refactor —
    // rather than one violating the type deliberately in-repo.
    const unsafeInput = { trustProxy: true } as unknown as { trustProxy: SafeTrustProxyOption };

    expect(() => createFastifyAdapterOptions(unsafeInput)).toThrow(/trustProxy: true is refused/);
  });

  it('createFastifyAdapter builds a FastifyAdapter using the same options', () => {
    const adapter = createFastifyAdapter();
    const instance = adapter.getInstance();

    expect(instance.initialConfig.bodyLimit).toBe(DEFAULT_BODY_LIMIT_BYTES);
  });

  // What the option does to `request.ip` behind the admin panel's proxy
  // (#331, ADR-0052) — the address every per-IP rate limit keys on.
  describe('request.ip behind a trusted proxy', () => {
    async function ipSeen(
      trustProxy: SafeTrustProxyOption,
      remoteAddress: string,
      forwardedFor?: string,
    ): Promise<string> {
      const server = Fastify(createFastifyAdapterOptions({ trustProxy }));
      server.get('/ip', (request) => ({ ip: request.ip }));
      try {
        const res = await server.inject({
          method: 'GET',
          url: '/ip',
          remoteAddress,
          headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
        });
        return res.json<{ ip: string }>().ip;
      } finally {
        await server.close();
      }
    }

    it('takes the address the proxy saw, not one the client wrote before it', async () => {
      // nginx appends the peer it saw to whatever the client sent.
      expect(await ipSeen(['10.0.0.5'], '10.0.0.5', '198.51.100.7, 203.0.113.9')).toBe(
        '203.0.113.9',
      );
    });

    it('ignores the header from a peer that is not the proxy', async () => {
      expect(await ipSeen(['10.0.0.5'], '192.0.2.44', '203.0.113.9')).toBe('192.0.2.44');
    });

    it('ignores the header entirely when no proxy is trusted', async () => {
      expect(await ipSeen(false, '10.0.0.5', '203.0.113.9')).toBe('10.0.0.5');
    });
  });
});
