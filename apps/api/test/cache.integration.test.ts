import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CacheService, namespacedCacheKey } from '../src/infra/cache/cache.service';
import { parseEnv } from '../src/infra/config/parse-env';

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

/**
 * The parsed configuration the service takes, for `REDIS_KEY_PREFIX` (#125).
 * Built through the schema rather than read off `process.env`, so this file
 * namespaces keys the same way the application does or fails the same way.
 */
const config = parseEnv(process.env);

/**
 * What a logical key from {@link key} actually looks like in Redis.
 *
 * `CacheService` prepends the run namespace itself, so a test that reaches
 * past it — setting a key by hand, or reading a TTL back — has to spell the
 * stored form. Before #125 the two were the same string, which is precisely
 * why the namespace was easy to leave out.
 */
function stored(name: string): string {
  return namespacedCacheKey(config.redis.keyPrefix, key(name));
}

let redis: Redis;
let cache: CacheService;

beforeAll(() => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  cache = new CacheService(redis, config);
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

  it('treats a cache hit as a miss when the caller-supplied accept check rejects it', async () => {
    // Simulates a rolling deploy: an old instance wrote a payload shaped one
    // way, and a new instance reading the same key must not trust it as its
    // own shape just because the envelope itself parses.
    const cacheKey = key('accept-reject');
    await cache.readThrough(cacheKey, 60, () => Promise.resolve({ shape: 'v1' }));

    const loader = vi.fn(() => Promise.resolve({ shape: 'v2' }));
    const result = await cache.readThrough(cacheKey, 60, loader, () => false);

    expect(result).toEqual({ shape: 'v2' });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('serves the cached value when the caller-supplied accept check accepts it', async () => {
    const cacheKey = key('accept-ok');
    await cache.readThrough(cacheKey, 60, () => Promise.resolve('cached value'));

    const loader = vi.fn(() => Promise.resolve('should not be used'));
    const result = await cache.readThrough(cacheKey, 60, loader, () => true);

    expect(result).toBe('cached value');
    expect(loader).not.toHaveBeenCalled();
  });

  it('behaves exactly as before when accept is omitted', async () => {
    const loader = vi.fn(() => Promise.resolve('unshaped value'));
    const cacheKey = key('accept-omitted');

    const first = await cache.readThrough(cacheKey, 60, loader);
    const second = await cache.readThrough(cacheKey, 60, loader);

    expect(second).toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('sets a TTL at or above the requested value, never below it', async () => {
    const cacheKey = key('ttl-floor');

    await cache.readThrough(cacheKey, 10, () => Promise.resolve('value'));

    const ttl = await redis.ttl(stored('ttl-floor'));

    // Jitter only ever adds to the requested TTL; a caller's TTL is a floor.
    expect(ttl).toBeGreaterThanOrEqual(10);
  });
});

describe('CacheService — invalidatePrefix', () => {
  it('removes every key under the prefix and leaves a key outside it untouched', async () => {
    const scopedPrefix = key('invalidate:');
    const insidePrimary = `${stored('invalidate:')}alpha`;
    const insideSecondary = `${stored('invalidate:')}beta`;
    const outside = stored('invalidate-sibling:untouched');

    await redis.set(insidePrimary, JSON.stringify({ v: 'a' }));
    await redis.set(insideSecondary, JSON.stringify({ v: 'b' }));
    await redis.set(outside, JSON.stringify({ v: 'c' }));

    await cache.invalidatePrefix(scopedPrefix);

    expect(await redis.get(insidePrimary)).toBeNull();
    expect(await redis.get(insideSecondary)).toBeNull();
    expect(await redis.get(outside)).not.toBeNull();

    await redis.unlink(outside);
  });

  it('escapes glob metacharacters in the prefix, so a literal `[` matches literally', async () => {
    const literalPrefix = key('glob[literal]:');
    const literalKey = `${stored('glob[literal]:')}item`;

    // Unescaped, `[literal]` in a MATCH pattern is a character class — it
    // matches a single character from the set {l,i,t,e,r,a}, not the seven
    // literal characters `[literal]`. Against the literal key below, that
    // means an unescaped prefix fails to match at all, and the key survives
    // invalidation it should not have.
    await redis.set(literalKey, JSON.stringify({ v: 'x' }));

    await cache.invalidatePrefix(literalPrefix);

    expect(await redis.get(literalKey)).toBeNull();
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
    unreachableCache = new CacheService(unreachable, config);
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
