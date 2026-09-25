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
});
