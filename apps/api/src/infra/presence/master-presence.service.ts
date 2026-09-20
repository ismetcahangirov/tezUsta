import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { REDIS_CLIENT } from '../redis/redis.tokens';

/**
 * The Redis key one master's liveness lives under.
 *
 * Namespaced so a `KEYS <prefix>:presence:master:*` in an incident names
 * exactly the live masters of that deployment and nothing else. The value is
 * the timestamp the presence was last refreshed — never anything about the
 * master, because a Redis instance is a different blast radius from Postgres
 * and presence needs no personal data to work.
 *
 * `keyPrefix` is `REDIS_KEY_PREFIX` (#125), and it is what makes the glob
 * above safe to run: without it, two checkouts sharing one Redis write the
 * same keys, and a suite that cleaned up after itself by pattern deleted two
 * other suites' presence mid-test.
 *
 * Exported rather than kept private because the key shape belongs in one
 * place: the tests that seed or assert presence directly build it from here
 * instead of re-spelling it, so a change to the layout cannot leave them
 * silently pointing at keys nobody writes.
 */
export function presenceKey(keyPrefix: string, masterId: string): string {
  return `${keyPrefix}:presence:master:${masterId}`;
}

/**
 * Whether a master is actually reachable right now.
 *
 * **This is one half of "online"**, and the half that can expire. Postgres
 * holds the master's *intent* (`masters.is_available` — they toggled the
 * switch); this holds their *liveness*, refreshed by a heartbeat and gone on
 * its own if the heartbeats stop. Matching requires both, evaluated together
 * (`docs/architecture/realtime-architecture.md` § Presence).
 *
 * The TTL is the entire point. A boolean column has no way to expire, so a
 * phone that died in a tunnel would stay "available" forever and dispatch
 * would keep offering work to a switched-off handset — the failure that ends
 * with a customer waiting for a master who was never coming.
 *
 * Redis is the right store for exactly the reason it is the wrong one for
 * `otp_challenges`: losing this key is cheap. A master whose presence is
 * evicted looks offline, stops receiving offers, and is back within one
 * heartbeat. Nothing is lost that cannot re-derive itself in a minute.
 */
@Injectable()
export class MasterPresenceService {
  private readonly logger = new Logger(MasterPresenceService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** This run's namespace for every presence key — see {@link presenceKey}. */
  private key(masterId: string): string {
    return presenceKey(this.config.redis.keyPrefix, masterId);
  }

  /** Seconds a presence survives with no heartbeat. */
  get ttlSeconds(): number {
    return this.config.presence.ttlSeconds;
  }

  /** How often a client is expected to refresh it. */
  get heartbeatSeconds(): number {
    return this.config.presence.heartbeatSeconds;
  }

  /**
   * Marks a master live, or refreshes how long they stay that way.
   *
   * `SET key value EX ttl` rather than `EXPIRE` on an existing key: going
   * online and beating are the same write, and a heartbeat that only extended
   * an existing key would silently do nothing for a master whose presence had
   * already lapsed — which is precisely the master who most needs it back.
   */
  async refresh(masterId: string, now: Date = new Date()): Promise<void> {
    await this.redis.set(
      this.key(masterId),
      String(now.getTime()),
      'EX',
      this.config.presence.ttlSeconds,
    );
  }

  /** Drops the presence immediately, without waiting out the TTL. */
  async clear(masterId: string): Promise<void> {
    await this.redis.del(this.key(masterId));
  }

  /**
   * Seconds of liveness left, or `null` when the master is not live.
   *
   * Returns the remaining TTL rather than a boolean because the client needs
   * it: `docs/product/master-flow.md` requires that a master be *told* when
   * their reporting has gone stale rather than silently shown as active, and
   * "your presence lapses in 12 seconds" is the only thing that makes that
   * warning possible before the fact rather than after it.
   */
  async remainingSeconds(masterId: string): Promise<number | null> {
    // -2 means the key does not exist, -1 that it exists with no TTL. The
    // second cannot happen here — every write above sets one — but a value
    // without an expiry would be a phantom master forever, so it reads as
    // "not live" rather than as "live indefinitely".
    const ttl = await this.redis.ttl(this.key(masterId));
    return ttl > 0 ? ttl : null;
  }

  /**
   * Live presence for many masters at once, for dispatch (EPIC 7).
   *
   * One `MGET` rather than a `TTL` per candidate: the nearby query can return
   * dozens of masters, and a round trip each would put Redis latency on the
   * dispatch path multiplied by the candidate count. Existence is enough here —
   * a key that exists has not expired, which is the whole question — so the
   * remaining seconds are not needed and are not fetched.
   */
  async filterLive(masterIds: readonly string[]): Promise<Set<string>> {
    if (masterIds.length === 0) {
      return new Set();
    }
    const values = await this.redis.mget(...masterIds.map((masterId) => this.key(masterId)));
    const live = new Set<string>();
    masterIds.forEach((masterId, index) => {
      if (values[index] !== null && values[index] !== undefined) {
        live.add(masterId);
      }
    });
    return live;
  }

  /**
   * Presence, treating a Redis outage as "not live".
   *
   * The only caller that should use this is a read whose job is to *show* a
   * master their own state. Failing the whole request because Redis blinked
   * would take the availability screen down with it, and the honest answer
   * during an outage is the conservative one: we cannot confirm you are
   * reachable.
   *
   * Dispatch deliberately does **not** get this treatment. A matching path
   * that treated an outage as "everybody is live" would offer work to phones
   * nobody can reach, and one that treated it as "nobody is live" would say so
   * loudly by finding no masters at all. Either way it must see the error.
   */
  async remainingSecondsOrOffline(masterId: string): Promise<number | null> {
    try {
      return await this.remainingSeconds(masterId);
    } catch (error: unknown) {
      this.logger.warn(
        `presence read failed for master ${masterId}, reporting offline: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return null;
    }
  }
}
