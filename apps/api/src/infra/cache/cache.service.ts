import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../redis/redis.tokens';

/**
 * How many keys `SCAN` is asked to inspect per round trip in
 * {@link CacheService.invalidatePrefix}. This is a hint to Redis, not a hard
 * cap on the batch it returns, and it exists only to keep each round trip
 * cheap on a large keyspace — the loop keeps calling `SCAN` with the returned
 * cursor until Redis reports it is back at `'0'`, so no key under the prefix
 * is missed regardless of this number.
 */
const SCAN_BATCH_SIZE = 200;

const logger = new Logger('CacheService');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The on-the-wire shape `readThrough` writes and reads back.
 *
 * A bare `JSON.stringify(value)` is ambiguous the moment `value` can be
 * `null`: `GET key` returning the string `"null"` and `GET key`
 * returning nothing (a miss) would both have to be treated as "no cached
 * value", which means a load function that legitimately resolves to `null`
 * (e.g. "no active promotion for this city") can never be cached — every read
 * would re-run `load()` forever, silently defeating the cache for exactly the
 * results that are cheapest to remember. Wrapping the value in `{ v: value }`
 * gives "the key exists and its value is `null`" and "the key does not exist"
 * distinct wire representations, so a hit is a hit regardless of what was
 * cached.
 *
 * `undefined` is the one value this cannot carry: `JSON.stringify({ v:
 * undefined })` drops the key entirely, so the envelope reads back as
 * `{}` and is treated as a miss. That is a limitation, not a bug to work
 * around — a loader that means "nothing here" should resolve to `null`, which
 * is what every caller in this repository does, and inventing a sentinel for
 * `undefined` would add a wire format nobody needs.
 */
interface CacheEnvelope<T> {
  readonly v: T;
}

function isEnvelopeShaped(value: unknown): value is { v: unknown } {
  return typeof value === 'object' && value !== null && 'v' in value;
}

type CacheLookup<T> = { readonly hit: true; readonly value: T } | { readonly hit: false };

/**
 * A Redis-backed read-through cache for values that are expensive to
 * recompute but tolerant of being briefly stale — the service catalogue is
 * the first consumer (issue #32): it changes rarely, every customer and
 * master reads it, and re-running its query on every request buys nothing.
 *
 * **Why this lives on top of `REDIS_CLIENT` rather than owning its own
 * connection.** `RedisModule` already owns the one `ioredis` client for the
 * process — its retry strategy, its error routing, its readiness check. A
 * second client here would be a second thing that can be half-connected while
 * the first is healthy, and a second thing `AppModule`'s shutdown would need
 * to know about. `RateLimiterService` is the existing precedent for injecting
 * `REDIS_CLIENT` directly rather than wrapping it again.
 *
 * **Why a cache outage must never become a request outage.** This service
 * backs public, unauthenticated read endpoints. If a Redis hiccup could turn
 * `GET /services` into a 500, then adding a cache would have made
 * the endpoint *less* available than it was before caching existed — the
 * opposite of what a cache is for. Every Redis operation here is therefore
 * wrapped so that a failure degrades to "behave as if nothing were cached"
 * rather than propagating. The one exception is `load()` itself: if the
 * caller's own function to fetch the real data throws, that error is real and
 * must reach the caller — swallowing it would turn a database outage into a
 * silent empty response, which is a worse failure than a loud one.
 *
 * **Why there is no in-process fallback layer.** CLAUDE.md §12 rules out
 * in-process state that two API instances could disagree about. A local
 * memory cache would also reintroduce the exact staleness problem Redis
 * solves for a horizontally scaled API: instance A could serve a stale value
 * for the whole of its own TTL after instance B has already invalidated and
 * refreshed the shared one. Redis being down means falling all the way back
 * to `load()`, not to a second, worse cache.
 */
@Injectable()
export class CacheService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Returns the cached value for `key` if one exists and is well-formed;
   * otherwise calls `load()`, caches its result for `ttlSeconds`, and returns
   * it.
   *
   * **Type safety, honestly stated.** `JSON.parse` yields `unknown`, and the
   * cast from that `unknown` to `T` here is a TRUSTED ASSERTION, not a
   * validated one: it says "whatever this process wrote under this key, under
   * this generic parameter, is what a well-formed hit will still look like
   * when it reads that key back". There is deliberately no Zod schema
   * re-validating the payload on every hit — the write and the read of a given
   * key are the same code path in the same process, so the shape cannot drift
   * between them the way an external API's response could. Re-validating a
   * value this process itself wrote a moment (or a TTL) ago would be padding
   * the hot path with a check that can only ever pass. A key whose payload is
   * NOT well-formed JSON — a stale value from a previous, incompatible cache
   * version, or a bit-flip — is handled as a miss (see below), not as a type
   * error to smuggle past `T`.
   */
  async readThrough<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const lookup = await this.tryGet<T>(key);
    if (lookup.hit) {
      return lookup.value;
    }

    // Not wrapped: a failure here belongs to the caller's data source, not to
    // this cache, and must be visible.
    const value = await load();

    await this.trySet(key, value, ttlSeconds);

    return value;
  }

  /**
   * Removes every key beginning with `prefix` — the shape of invalidation a
   * cache keyed by e.g. `catalogue:v1:services:<category-id>:50` needs when the
   * underlying row set changes and every key under that category, not one
   * specific key, is now stale.
   *
   * **Why `SCAN` and never `KEYS`.** Redis is single-threaded for command
   * execution: `KEYS prefix*` walks the ENTIRE keyspace in one command and
   * blocks every other client — every request the whole API is serving —
   * for however long that walk takes. On a small dev keyspace that is
   * invisible; on a production keyspace shared with rate-limit counters,
   * sessions and everything else this process caches, it is a
   * multi-millisecond-to-multi-second stall shared by every unrelated
   * request in flight, self-inflicted by one cache invalidation. `SCAN`
   * walks the same keyspace incrementally, cursor by cursor, interleaved with
   * every other command Redis is serving, so it costs the many small pauses
   * this loop makes instead of the one large one `KEYS` would.
   *
   * **Why `UNLINK` and never `DEL`.** `DEL` frees the key's memory
   * synchronously, on the same thread that is answering everyone else's
   * commands — for a large value (or many of them in one pipeline) that is
   * the same single-threaded stall `KEYS` causes, just moved from lookup to
   * deletion. `UNLINK` reclaims the memory on a background thread and returns
   * immediately, which is what makes it safe to call from a request path that
   * other traffic is sharing.
   *
   * **Resilience.** Like `readThrough`, a `SCAN` or `UNLINK` failure here
   * degrades rather than throws: invalidation is called after a write
   * succeeds, and failing the write's response because the cache could not be
   * cleared would again convert a Redis hiccup into an outage of something
   * else. The cost of a failed invalidation is a stale cache entry for at
   * most `ttlSeconds` — bounded and self-healing — not a request failure.
   */
  async invalidatePrefix(prefix: string): Promise<void> {
    let cursor = '0';

    do {
      let nextCursor: string;
      let keys: string[];
      try {
        [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          `${prefix}*`,
          'COUNT',
          SCAN_BATCH_SIZE,
        );
      } catch (error) {
        logger.warn(
          `Cache invalidation scan failed; some keys under the prefix may remain until their ` +
            `TTL expires: ${errorMessage(error)}`,
        );
        return;
      }

      cursor = nextCursor;

      if (keys.length > 0) {
        try {
          await this.redis.unlink(...keys);
        } catch (error) {
          logger.warn(
            `Cache invalidation unlink failed; some keys under the prefix may remain until ` +
              `their TTL expires: ${errorMessage(error)}`,
          );
        }
      }
    } while (cursor !== '0');
  }

  /**
   * A GET that throws (Redis unreachable), a miss (key absent), and a hit
   * whose payload is not the envelope this process writes (a stale shape from
   * an earlier cache version, or corruption) are collapsed into the same
   * `{ hit: false }` result on purpose: every one of them means "there is
   * nothing here this process can trust", and the caller's response to all
   * three is identical — fall back to `load()`. Distinguishing them further
   * would only tempt a caller to treat "corrupt" differently from "absent",
   * which is not a distinction a public read endpoint should ever act on.
   */
  private async tryGet<T>(key: string): Promise<CacheLookup<T>> {
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch (error) {
      logger.warn(`Cache read failed; serving this request from source: ${errorMessage(error)}`);
      return { hit: false };
    }

    if (raw === null) {
      return { hit: false };
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isEnvelopeShaped(parsed)) {
        throw new Error('cached payload was not the expected { v } envelope');
      }
      return { hit: true, value: parsed.v as T };
    } catch (error) {
      logger.warn(
        `Cache payload could not be parsed; serving this request from source: ${errorMessage(error)}`,
      );
      return { hit: false };
    }
  }

  private async trySet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      const envelope: CacheEnvelope<T> = { v: value };
      await this.redis.set(key, JSON.stringify(envelope), 'EX', ttlSeconds);
    } catch (error) {
      // The request already has its answer from `load()` — a failed write
      // only means the NEXT request also pays the load cost, not that this
      // one fails.
      logger.warn(`Cache write failed; this response will not be cached: ${errorMessage(error)}`);
    }
  }
}
