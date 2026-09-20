import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CacheService } from '../src/infra/cache/cache.service';
import type { AppConfig } from '../src/infra/config/app-config.types';
import { parseEnv } from '../src/infra/config/parse-env';
import { MasterPresenceService } from '../src/infra/presence/master-presence.service';

/**
 * `REDIS_KEY_PREFIX` isolation (issue #125), against a real Redis.
 *
 * The acceptance criterion behind the variable is the one
 * `deferred-work.e2e.test.ts` already asserts for `QUEUE_PREFIX`: two runs
 * against one Redis must not see each other's state. It is asserted from the
 * outside here too — two services built with different prefixes, one Redis
 * between them — because that is the failure the namespace exists to prevent,
 * and it is invisible to any test that only ever builds one.
 *
 * Presence was the keyspace that actually bit. Three suites seed overlapping
 * master ids, and before this variable a pattern delete in one of them took
 * the other two's presence with it mid-test, where the symptom read as a
 * presence bug in a file that did nothing wrong.
 *
 * `docker compose up -d` must be running; `test/setup-env.ts` supplies
 * `REDIS_URL`.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

function configWithPrefix(prefix: string): AppConfig {
  return parseEnv({ ...process.env, REDIS_KEY_PREFIX: prefix });
}

/** Two namespaces that are distinct from each other and from every other run. */
const RUN = randomUUID().replaceAll('-', '').slice(0, 10);
const PREFIX_A = `a-${RUN}`;
const PREFIX_B = `b-${RUN}`;

let redis: Redis;

beforeAll(() => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
});

afterAll(async () => {
  for (const prefix of [PREFIX_A, PREFIX_B]) {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
  redis.disconnect();
});

describe('REDIS_KEY_PREFIX — presence (issue #125)', () => {
  it('makes a presence written under one prefix invisible under another', async () => {
    const masterId = randomUUID();
    const mine = new MasterPresenceService(redis, configWithPrefix(PREFIX_A));
    const theirs = new MasterPresenceService(redis, configWithPrefix(PREFIX_B));

    await mine.refresh(masterId);

    // Positive half first: without it, "the other run cannot see it" would
    // pass just as well if nothing had been written at all.
    expect(await mine.remainingSeconds(masterId)).toBeGreaterThan(0);
    expect(await theirs.remainingSeconds(masterId)).toBeNull();
    expect(await theirs.filterLive([masterId])).toEqual(new Set());
    expect(await mine.filterLive([masterId])).toEqual(new Set([masterId]));
  });

  it('confines a pattern delete to the run that issued it', async () => {
    // The workaround this variable removed: a suite cleaning up its own
    // presence by glob used to delete every other suite's as well.
    const mineId = randomUUID();
    const theirsId = randomUUID();
    const mine = new MasterPresenceService(redis, configWithPrefix(PREFIX_A));
    const theirs = new MasterPresenceService(redis, configWithPrefix(PREFIX_B));

    await mine.refresh(mineId);
    await theirs.refresh(theirsId);

    const sweep = await redis.keys(`${PREFIX_A}:presence:master:*`);
    expect(sweep.length).toBeGreaterThan(0);
    await redis.del(...sweep);

    expect(await mine.remainingSeconds(mineId)).toBeNull();
    expect(await theirs.remainingSeconds(theirsId)).toBeGreaterThan(0);
  });

  it("clears only its own run, so `clear` cannot reach another run's master", async () => {
    const masterId = randomUUID();
    const mine = new MasterPresenceService(redis, configWithPrefix(PREFIX_A));
    const theirs = new MasterPresenceService(redis, configWithPrefix(PREFIX_B));

    await mine.refresh(masterId);
    await theirs.refresh(masterId);

    await theirs.clear(masterId);

    expect(await mine.remainingSeconds(masterId)).toBeGreaterThan(0);
    expect(await theirs.remainingSeconds(masterId)).toBeNull();
  });
});

describe('REDIS_KEY_PREFIX — cache (issue #125)', () => {
  it('does not serve one run a value another run cached under the same key', async () => {
    const key = `catalogue:v1:isolation:${RUN}`;
    const mine = new CacheService(redis, configWithPrefix(PREFIX_A));
    const theirs = new CacheService(redis, configWithPrefix(PREFIX_B));

    const mineLoader = vi.fn(() => Promise.resolve('mine'));
    const theirsLoader = vi.fn(() => Promise.resolve('theirs'));

    expect(await mine.readThrough(key, 60, mineLoader)).toBe('mine');
    // A hit for the run that wrote it — the positive control for the miss
    // below, which would otherwise pass against a cache that never writes.
    expect(await mine.readThrough(key, 60, mineLoader)).toBe('mine');
    expect(mineLoader).toHaveBeenCalledTimes(1);

    expect(await theirs.readThrough(key, 60, theirsLoader)).toBe('theirs');
    expect(theirsLoader).toHaveBeenCalledTimes(1);
  });

  it('confines invalidation to the run that asked for it', async () => {
    const key = `catalogue:v1:invalidate:${RUN}`;
    const mine = new CacheService(redis, configWithPrefix(PREFIX_A));
    const theirs = new CacheService(redis, configWithPrefix(PREFIX_B));

    await mine.readThrough(key, 60, () => Promise.resolve('mine'));
    await theirs.readThrough(key, 60, () => Promise.resolve('theirs'));

    await mine.invalidatePrefix('catalogue:v1:');

    const mineAgain = vi.fn(() => Promise.resolve('reloaded'));
    const theirsAgain = vi.fn(() => Promise.resolve('reloaded'));

    expect(await mine.readThrough(key, 60, mineAgain)).toBe('reloaded');
    expect(mineAgain).toHaveBeenCalledTimes(1);

    expect(await theirs.readThrough(key, 60, theirsAgain)).toBe('theirs');
    expect(theirsAgain).not.toHaveBeenCalled();
  });
});
