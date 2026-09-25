import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../database/database.tokens';
import type { Database } from '../database/database.types';
import { geocodeCache } from '../database/schema/geocode-cache';
import type { GeocodedPoint } from './geocoding.types';

/**
 * The Postgres geocode cache: read by normalised address, written after a
 * provider call, and never holding anything but a point and a place id.
 *
 * Why Postgres and not Redis, where the other caches in this project live: a
 * geocode is expensive to re-acquire in money rather than in milliseconds, and
 * an evicted Redis key would silently turn into another line on the Maps
 * invoice. ADR-0004 says Postgres for exactly that reason. `CacheService` stays
 * right for the catalogue, where a miss costs one cheap query.
 */
@Injectable()
export class GeocodeCacheRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * An unexpired hit, or `undefined`.
   *
   * Expiry is part of the WHERE rather than something the caller checks after
   * reading, so there is no code path in which a stale row is served because
   * somebody forgot the comparison — and nothing deletes on read: the refresh
   * happens through {@link put} on the path that was already going to call the
   * provider, so a miss costs one query and never a second write.
   */
  async get(normalisedAddress: string): Promise<GeocodedPoint | undefined> {
    const [row] = await this.db
      .select({
        latitude: geocodeCache.latitude,
        longitude: geocodeCache.longitude,
        placeId: geocodeCache.placeId,
      })
      .from(geocodeCache)
      .where(
        and(
          eq(geocodeCache.normalisedAddress, normalisedAddress),
          gt(geocodeCache.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Stores or refreshes one entry.
   *
   * `updated_at` is written explicitly on both branches because the table's
   * licence CHECK compares `expires_at` against it — see the comment on
   * `geocode_cache_licence_ttl`. Leaving it to `$onUpdate` would work today and
   * would break the day somebody writes through a different code path.
   */
  async put(normalisedAddress: string, point: GeocodedPoint, ttlDays: number): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

    await this.db
      .insert(geocodeCache)
      .values({
        normalisedAddress,
        latitude: point.latitude,
        longitude: point.longitude,
        placeId: point.placeId,
        expiresAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: geocodeCache.normalisedAddress,
        set: {
          latitude: point.latitude,
          longitude: point.longitude,
          placeId: point.placeId,
          expiresAt,
          updatedAt: now,
        },
      });
  }

  /**
   * Deletes expired rows and reports how many went.
   *
   * Nothing calls this on a schedule yet — that is a BullMQ repeatable job and
   * it belongs to the Epic that introduces the queue. It exists now because the
   * alternative to having it is a table that only ever grows, and because a
   * sweep somebody has to write from scratch later is a sweep nobody writes.
   */
  async deleteExpired(limit = 10_000): Promise<number> {
    const deleted = await this.db.execute<{ normalised_address: string }>(
      sql`delete from ${geocodeCache}
          where ${geocodeCache.normalisedAddress} = any(array(
            select ${geocodeCache.normalisedAddress} from ${geocodeCache}
            where ${geocodeCache.expiresAt} <= now()
            limit ${limit}
          ))
          returning ${geocodeCache.normalisedAddress}`,
    );
    return deleted.rows.length;
  }
}
