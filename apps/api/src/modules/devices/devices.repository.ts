import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import type { DeviceRow } from '../../infra/database/schema/devices';
import { devices } from '../../infra/database/schema/devices';

/** Everything a registration carries; the optional members may be absent. */
export interface NewDeviceFields {
  readonly userId: string;
  readonly expoPushToken: string;
  readonly platform: 'ios' | 'android';
  readonly deviceId?: string | undefined;
  readonly appVersion?: string | undefined;
}

@Injectable()
export class DevicesRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Register a token, or refresh the registration it already has.
   *
   * **One statement, and that is the whole concurrency story.** The unique
   * index on `expo_push_token` turns "does this token exist, and whose is it?"
   * into a conflict the database resolves, so two API replicas registering the
   * same token at the same instant produce one row rather than two — or, in
   * the read-then-write version of this method, one row and one unique
   * violation surfaced to a user who did nothing wrong.
   *
   * Three things happen on conflict, and each is deliberate:
   *
   * - **`user_id` is overwritten.** A token that already belongs to somebody
   *   else moves to the caller. The phone changed hands, or its previous owner
   *   signed out without the client getting a chance to unregister. Leaving
   *   the old owner in place would send their order notifications to whoever
   *   is holding the phone now, which is a PII leak
   *   (`docs/engineering/security.md` § PII and privacy) rather than an
   *   untidy row.
   * - **The revocation is cleared, both halves together.** A phone signing
   *   back in must become reachable again; clearing `revoked_at` and forgetting
   *   `revoked_reason` is exactly what the `devices_revocation_shape` CHECK
   *   exists to make impossible, so the pair is written as a pair.
   * - **`last_seen_at` moves.** A re-registration is the only evidence the
   *   server ever gets that an installation is still alive.
   *
   * `id` is generated for the insert and never referenced on the update path,
   * so a device that re-registers keeps the id its client already stored — the
   * id it will later present to `DELETE /devices/:id`.
   */
  async register(fields: NewDeviceFields): Promise<DeviceRow> {
    const [row] = await this.db
      .insert(devices)
      .values({
        id: uuidV7(),
        userId: fields.userId,
        expoPushToken: fields.expoPushToken,
        platform: fields.platform,
        deviceId: fields.deviceId ?? null,
        appVersion: fields.appVersion ?? null,
      })
      .onConflictDoUpdate({
        target: devices.expoPushToken,
        set: {
          userId: fields.userId,
          platform: fields.platform,
          deviceId: fields.deviceId ?? null,
          appVersion: fields.appVersion ?? null,
          lastSeenAt: new Date(),
          revokedAt: null,
          revokedReason: null,
        },
      })
      .returning();

    if (row === undefined) {
      // `ON CONFLICT DO UPDATE` always returns its row, so this is
      // unreachable — but the driver's type admits it, and inventing a
      // non-null assertion would be a lie about the contract.
      throw new Error('device registration returned no row');
    }
    return row;
  }

  /**
   * This user's live devices, most recently active first.
   *
   * Reads `devices_user_id_live_idx` — the partial index
   * `docs/architecture/database-architecture.md` § Indexing names for the push
   * fan-out. The ordering is by `last_seen_at` because that is what a person
   * scanning their own device list is actually looking for: the phone they
   * used last.
   */
  async listLiveByUser(userId: string): Promise<DeviceRow[]> {
    return this.db
      .select()
      .from(devices)
      .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)))
      .orderBy(desc(devices.lastSeenAt), desc(devices.id));
  }

  /**
   * Every live device of one user — what the notification worker fans out to.
   *
   * Separate from {@link listLiveByUser} only in what it returns: the worker
   * needs the token, and the list endpoint must never see one. Keeping them
   * apart means the redaction is not one forgotten `.map` away from being a
   * response that carries push addresses.
   */
  async listAddressableByUser(userId: string): Promise<{ id: string; expoPushToken: string }[]> {
    return this.db
      .select({ id: devices.id, expoPushToken: devices.expoPushToken })
      .from(devices)
      .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)))
      .orderBy(desc(devices.lastSeenAt), desc(devices.id));
  }

  /**
   * Retire a device the push provider reported as gone.
   *
   * Addressed by id and **not scoped to a user**, because the caller is the
   * notification worker rather than a request — there is no actor to check
   * against, and the authority is Expo's answer. Still conditional on
   * `revoked_at IS NULL`, so a device a user unregistered a moment earlier
   * keeps `unregistered` as its reason rather than having it overwritten by a
   * late ticket about a push that was already in flight.
   */
  async retireUnreachable(deviceId: string): Promise<boolean> {
    const [row] = await this.db
      .update(devices)
      .set({ revokedAt: new Date(), revokedReason: 'unreachable' })
      .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)))
      .returning({ id: devices.id });

    return row !== undefined;
  }

  /**
   * Retire one live device belonging to one user.
   *
   * **Conditional on both the owner and on still being live**, in the
   * statement rather than in a preceding read. The owner clause is what makes
   * a stranger's id indistinguishable from an absent one without a separate
   * lookup that could disagree with the write; the `revoked_at IS NULL` clause
   * makes a double unregister return zero rows rather than quietly rewriting
   * the reason and the timestamp of a device that was retired days ago.
   *
   * Returns the row when this call is the one that retired it, and `null`
   * otherwise — which the service turns into the same 404 an unknown id gets.
   */
  async revokeOwn(userId: string, deviceId: string): Promise<DeviceRow | null> {
    const [row] = await this.db
      .update(devices)
      .set({ revokedAt: new Date(), revokedReason: 'unregistered' })
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)))
      .returning();

    return row ?? null;
  }
}
