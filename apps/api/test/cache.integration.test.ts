import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CacheService } from '../src/infra/cache/cache.service';

// Real Redis, not a fake. The properties under test — a real GET/SET round
// trip, a real TTL expiring, a real SCAN+UNLINK sweep, a real connection
// failure — are all properties OF Redis or of the ioredis client talking to
// it. A fake would only prove this file's own assumptions about Redis, which
// is the trap `rate-limiter.service.test.ts` documents the same way.
// `docker compose up -d` must be running; `test/setup-env.ts` supplies
// REDIS_URL.
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * Every key this file touches carries a fresh UUID under this run's own
 * prefix, so a concurrent `pnpm test` in another checkout against the same
 * shared Redis container cannot collide with this one, and a re-run cannot
 * collide with a previous one's leftovers. Cleanup in `afterAll` still runs —
 * a leaked key is litter in somebody else's database even when it cannot
 * cause a false pass.
 */
const RUN_ID = randomUUID();
const PREFIX = `test-cache:${RUN_ID}:`;

function key(name: string): string {
  return `${PREFIX}${name}`;
}

let redis: Redis;
let cache: CacheService;

beforeAll(() => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  cache = new CacheService(redis);
});

afterAll(async () => {
  await cache.invalidatePrefix(PREFIX);
  redis.disconnect();
});

describe('CacheService — read-through', () => {
  it('calls the loader on a miss and returns its value', async () => {
    const loader = vi.fn(() => Promise.resolve('freshly loaded'));

    const result = await cache.readThrough(key('miss'), 60, loader);

    expect(result).toBe('freshly loaded');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('serves a second read within the TTL from the cache, without calling the loader again', async () => {
    const loader = vi.fn(() => Promise.resolve({ value: 'expensive to compute' }));
    const cacheKey = key('hit');

    const first = await cache.readThrough(cacheKey, 60, loader);
    const second = await cache.readThrough(cacheKey, 60, loader);

    expect(second).toEqual(first);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('re-calls the loader once the cached value has expired', async () => {
    const loader = vi.fn(() => Promise.resolve(randomUUID()));
    const cacheKey = key('expiry');

    const first = await cache.readThrough(cacheKey, 1, loader);
    // Redis's own TTL is the clock under test here, not a mocked `Date.now`
    // — see `rate-limiter.service.test.ts` for why that distinction matters.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    const second = await cache.readThrough(cacheKey, 1, loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  it('serves a cached null from cache rather than re-loading', async () => {
    const loader = vi.fn((): Promise<string | null> => Promise.resolve(null));
    const cacheKey = key('null-value');

    const first = await cache.readThrough(cacheKey, 60, loader);
    const second = await cache.readThrough(cacheKey, 60, loader);

    expect(first).toBeNull();
    expect(second).toBeNull();
    // The whole reason for the `{ v }` envelope: a bare `null` payload is
    // indistinguishable on the wire from "no key", which would make this
    // assertion fail with a naive implementation — the loader would run
    // again on every read of a legitimately-null value.
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe('CacheService — invalidatePrefix', () => {
  it('removes every key under the prefix and leaves a key outside it untouched', async () => {
    const scopedPrefix = key('invalidate:');
    const insidePrimary = `${scopedPrefix}alpha`;
    const insideSecondary = `${scopedPrefix}beta`;
    const outside = key('invalidate-sibling:untouched');

    await redis.set(insidePrimary, JSON.stringify({ v: 'a' }));
    await redis.set(insideSecondary, JSON.stringify({ v: 'b' }));
    await redis.set(outside, JSON.stringify({ v: 'c' }));

    await cache.invalidatePrefix(scopedPrefix);

    expect(await redis.get(insidePrimary)).toBeNull();
    expect(await redis.get(insideSecondary)).toBeNull();
    expect(await redis.get(outside)).not.toBeNull();

    await redis.unlink(outside);
  });
});

describe('CacheService — resilience to a Redis outage', () => {
  let unreachable: Redis;
  let unreachableCache: CacheService;

  beforeAll(() => {
    // Deliberately unreachable: a closed local port fails fast (connection
    // refused) instead of timing out, and `retryStrategy: () => null` stops
    // ioredis from retrying forever so the test does not hang. The 'error'
    // listener is mandatory — an ioredis client with none turns a connection
    // failure into an unhandled 'error' event, which is fatal to the whole
    // process, not just this test.
    unreachable = new Redis({
      host: '127.0.0.1',
      port: 1,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    unreachable.on('error', () => undefined);
    unreachableCache = new CacheService(unreachable);
  });

  afterAll(() => {
    unreachable.disconnect();
  });

  it('still returns the loader result when Redis rejects every command', async () => {
    const loader = vi.fn(() => Promise.resolve('served despite redis being down'));

    const result = await unreachableCache.readThrough(key('unreachable'), 60, loader);

    expect(result).toBe('served despite redis being down');
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
