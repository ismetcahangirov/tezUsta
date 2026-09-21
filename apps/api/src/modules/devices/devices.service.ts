import { Injectable } from '@nestjs/common';
import type { Device } from '@tezusta/types';

import { NotFoundError } from '../../common/errors/not-found.error';
import type { DeviceRow } from '../../infra/database/schema/devices';
import type { Actor } from '../auth/auth.types';
import { DevicesRepository } from './devices.repository';
import type { RegisterDeviceRequest } from './devices.schema';
import { TOKEN_SUFFIX_LENGTH } from './devices.schema';

/**
 * The device registry: where a user's phones say how to reach them.
 *
 * **The owner is always the caller's own account**, resolved from the actor
 * and never from the request. There is no route here that names a user, so
 * the only id a client can send is a device id, and that one is checked
 * against the caller inside the statement that acts on it.
 *
 * Unlike `addresses`, nothing here resolves a role profile first. A device is
 * user-scoped: one binary carries both customer and master (CLAUDE.md §2), so
 * a phone receives whatever the event concerns and a caller with no profile at
 * all still has somewhere to be notified.
 */
@Injectable()
export class DevicesService {
  constructor(private readonly devices: DevicesRepository) {}

  /**
   * Register this caller's device, or refresh a registration it already has.
   *
   * Idempotent on the token, and it always answers 201: "created" and
   * "refreshed" are the same request from the client's point of view — the app
   * sends its token after every sign-in and after every rotation — and a
   * status that varied would invite a client to branch on something that
   * carries no information it can act on.
   */
  async register(actor: Actor, request: RegisterDeviceRequest): Promise<Device> {
    const row = await this.devices.register({
      userId: actor.userId,
      expoPushToken: request.expoPushToken,
      platform: request.platform,
      deviceId: request.deviceId,
      appVersion: request.appVersion,
    });
    return toDeviceResponse(row);
  }

  /** This caller's live devices. A retired one is simply not a device any more. */
  async list(actor: Actor): Promise<Device[]> {
    const rows = await this.devices.listLiveByUser(actor.userId);
    return rows.map(toDeviceResponse);
  }

  /**
   * Every live device of one user, with the token, for the notification
   * worker (#141).
   *
   * **Takes a user id rather than an `Actor`**, and that is the signature of
   * something a request must never reach: there is no caller to own these
   * rows, because the caller is a queued job. It is exported through this
   * module — rather than by exposing the repository — so the one method that
   * hands out push tokens is visible in the service every reviewer reads.
   */
  async addressableFor(userId: string): Promise<AddressableDevice[]> {
    return this.devices.listAddressableByUser(userId);
  }

  /**
   * Retire a device the push provider reported as gone (#141).
   *
   * No actor, for the reason above: the authority is Expo's answer, not a
   * user's request. Returns whether this call was the one that retired it.
   */
  async retireUnreachable(deviceId: string): Promise<boolean> {
    return this.devices.retireUnreachable(deviceId);
  }

  /**
   * Retire one of this caller's devices — what the app calls at sign-out.
   *
   * The ownership check is the `user_id` clause of the `UPDATE` itself, so
   * "not yours", "already retired" and "never existed" all return zero rows
   * and all become the same 404. That is the guarantee
   * `requireVisibleOrNotFound` exists to make structural, reached here by
   * making the write conditional instead of reading first: a read-then-write
   * would be two correct-looking steps whose disagreement is a window.
   */
  async retire(actor: Actor, deviceId: string): Promise<void> {
    const retired = await this.devices.revokeOwn(actor.userId, deviceId);
    if (retired === null) {
      throw new NotFoundError();
    }
  }
}

/**
 * One device as the notification worker addresses it.
 *
 * A different shape from {@link Device} on purpose: this one carries the push
 * token and never crosses HTTP, while that one crosses HTTP and never carries
 * the token. Two shapes rather than one with an optional field, because an
 * optional secret is one forgotten `delete` away from a response.
 */
export interface AddressableDevice {
  readonly id: string;
  readonly expoPushToken: string;
}

/**
 * A row as the API returns it — **without the push token**.
 *
 * The token is the address Expo delivers to, so anyone holding it can push to
 * that phone; CLAUDE.md §11 treats it like every other token. What goes over
 * the wire is the tail of it, which is enough for a person to tell two of
 * their own phones apart and not enough to address either.
 */
function toDeviceResponse(row: DeviceRow): Device {
  return {
    id: row.id,
    platform: row.platform,
    tokenSuffix: row.expoPushToken.slice(-TOKEN_SUFFIX_LENGTH),
    deviceId: row.deviceId,
    appVersion: row.appVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}
