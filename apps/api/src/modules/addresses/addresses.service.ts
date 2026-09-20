import { Injectable } from '@nestjs/common';
import type { Address } from '@tezusta/types';

import { requireVisibleOrNotFound } from '../../common/authorization/resource-visibility';
import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import type { AddressRow } from '../../infra/database/schema/addresses';
import type { Actor } from '../auth/auth.types';
import { CustomersService } from '../customers/customers.service';
import { AddressesRepository } from './addresses.repository';
import type { CreateAddressRequest, UpdateAddressRequest } from './addresses.schema';
import { MAX_SAVED_ADDRESSES } from './addresses.schema';

/**
 * Where an order is, and nothing else about it — the whole of what the
 * dispatch engine is given about a customer's address.
 */
export interface DispatchOrigin {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * The per-customer cap, reached. 409 rather than 422: the request is
 * well-formed and would have been accepted a moment ago against a different
 * state, which is exactly what a conflict is
 * (`docs/architecture/backend-architecture.md` § Error model).
 */
export class TooManyAddressesError extends AppError {
  constructor() {
    super(
      ERROR_CODES.CONFLICT,
      'You have reached the maximum number of saved addresses. Delete one to add another.',
      409,
    );
    this.name = 'TooManyAddressesError';
    Object.setPrototypeOf(this, TooManyAddressesError.prototype);
  }
}

/**
 * An attempt to leave a customer with no default address.
 *
 * A customer who has addresses has exactly one default; there is no state in
 * which they have three addresses and no preference. So "stop being the
 * default" is not an operation — promoting a different address is, and it
 * demotes this one as a consequence. The message says that, because a client
 * that gets a bare 409 here has no way to guess the fix.
 */
export class DefaultAddressRequiredError extends AppError {
  constructor() {
    super(
      ERROR_CODES.CONFLICT,
      'Set another address as the default instead of unsetting this one.',
      409,
    );
    this.name = 'DefaultAddressRequiredError';
    Object.setPrototypeOf(this, DefaultAddressRequiredError.prototype);
  }
}

/**
 * Saved addresses, scoped to the caller's customer profile.
 *
 * **Every method resolves the customer from the actor first.** No method takes
 * a customer id, so there is no request shape in which a caller names somebody
 * else's profile; and because {@link CustomersService.getOwn} throws
 * `NotFoundError` when the caller has no profile, "you are not a customer" and
 * "that address is not yours" are already the same 404 before any address is
 * looked at.
 *
 * **An address is PII** (`docs/engineering/security.md` § PII and privacy). It
 * reaches a master only through an order they have accepted — never from this
 * module, which is why nothing here takes a role into account: there is no role
 * that makes someone else's address visible.
 */
@Injectable()
export class AddressesService {
  constructor(
    private readonly addresses: AddressesRepository,
    private readonly customers: CustomersService,
  ) {}

  async create(actor: Actor, input: CreateAddressRequest): Promise<Address> {
    const customer = await this.customers.getOwn(actor);

    const outcome = await this.addresses.create({
      customerId: customer.id,
      fields: input,
      makeDefault: input.isDefault ?? false,
      maxLiveAddresses: MAX_SAVED_ADDRESSES,
    });

    if (outcome.kind === 'limit-reached') {
      throw new TooManyAddressesError();
    }
    return toAddressResponse(outcome.address);
  }

  async list(actor: Actor): Promise<Address[]> {
    const customer = await this.customers.getOwn(actor);
    const rows = await this.addresses.listByCustomer(customer.id);
    return rows.map(toAddressResponse);
  }

  async getById(actor: Actor, id: string): Promise<Address> {
    const customer = await this.customers.getOwn(actor);
    return toAddressResponse(await this.requireOwn(customer.id, id));
  }

  /**
   * Where an order at this address is, for the dispatch engine's radius search
   * (issue #103).
   *
   * **Takes no actor, and that is not an oversight.** There is no caller: a
   * dispatch tick runs on a clock with nobody making a request, so there is no
   * actor whose ownership could be checked. What replaces the check is that
   * the value never leaves the server — the engine hands it to a PostGIS
   * radius query and throws it away. A master's offer card carries a distance
   * band and never the address (`docs/product/master-flow.md`, CLAUDE.md §11),
   * and the coordinates are not logged at any level.
   *
   * Two coordinates rather than the whole `Address`, for exactly that reason:
   * a method that returned the formatted address, the building and the
   * apartment would be one careless caller away from putting a home on an
   * offer card.
   *
   * `undefined` when the address does not exist or has been soft-deleted —
   * which the order's `onDelete: 'restrict'` reference should make impossible,
   * and which the engine treats as the fault it would be rather than as an
   * empty search.
   */
  async getDispatchOrigin(addressId: string): Promise<DispatchOrigin | undefined> {
    const row = await this.addresses.findById(addressId);

    if (row === undefined) {
      return undefined;
    }

    // `position` is a PostGIS point in `xy` mode: x is longitude, y latitude.
    // The ordering is pinned by `database.geometry.test.ts`, because a swap is
    // invisible to every bound check in Baku.
    return { latitude: row.position.y, longitude: row.position.x };
  }

  async update(actor: Actor, id: string, patch: UpdateAddressRequest): Promise<Address> {
    const customer = await this.customers.getOwn(actor);
    const existing = await this.requireOwn(customer.id, id);

    if (patch.isDefault === false && existing.isDefault) {
      throw new DefaultAddressRequiredError();
    }

    const updated = await this.addresses.update({
      id,
      customerId: customer.id,
      fields: patch,
      makeDefault: patch.isDefault === true,
    });

    if (updated === undefined) {
      // The row was soft-deleted between the visibility check and the write.
      // The caller asked to edit something that is no longer there, and 404 is
      // the same answer they would have got a moment later.
      throw new NotFoundError();
    }
    return toAddressResponse(updated);
  }

  async delete(actor: Actor, id: string): Promise<void> {
    const customer = await this.customers.getOwn(actor);
    await this.requireOwn(customer.id, id);

    if (!(await this.addresses.softDelete(id))) {
      throw new NotFoundError();
    }
  }

  /**
   * One address by id, **with no ownership check of its own** — the dispatch
   * path's read (issue #101).
   *
   * Deliberately a separate method from {@link getById} rather than a flag on
   * it, for `MastersService.findForModeration`'s reason: a flag is one wrong
   * argument away from turning the ownership check off on a customer-facing
   * route, and this address is somebody's home.
   *
   * **Two callers, and the difference between them is the whole PII rule.**
   *
   * - The accept path needs the job site's *coordinates* to re-evaluate the
   *   radius term at the instant of the accept. That is a server-side
   *   computation and nothing from this row reaches the master.
   * - The winner — and only the winner — is then shown the whole address,
   *   because `docs/product/master-flow.md` reveals it at that instant and not
   *   before. The caller has established that from `orders.master_id`, written
   *   by the conditional `UPDATE` that decided the race.
   *
   * A master who was merely *offered* the job must never reach the second use:
   * a broadcast goes to every eligible master in range, so an address on an
   * offer card is a home address handed to everyone who never takes the job
   * (CLAUDE.md §11).
   *
   * Soft-deleted reads as absent, like every other read here. An order holds
   * its address by a `restrict` foreign key, so this can only be undefined for
   * an id that names nothing.
   */
  async findForOrderDispatch(addressId: string): Promise<Address | undefined> {
    const row = await this.addresses.findById(addressId);
    return row === undefined ? undefined : toAddressResponse(row);
  }

  /**
   * Resolve-then-authorize, in one call, so "does not exist" and "not yours"
   * cannot drift apart into two different answers. A 403 on a stranger's
   * address id would confirm that the id names a real address belonging to a
   * real customer — and an address is a home
   * (`docs/architecture/authentication.md` § Server ownership checks).
   */
  private async requireOwn(customerId: string, id: string): Promise<AddressRow> {
    return requireVisibleOrNotFound(
      await this.addresses.findById(id),
      (candidate) => candidate.customerId === customerId,
    );
  }
}

/**
 * The row-to-contract projection, in one place.
 *
 * An explicit field list rather than a spread with deletions: a column added to
 * this table later must not reach a client because nobody remembered to exclude
 * it. `customerId` and `deletedAt` are the two that matter most and neither
 * appears — the first is an identifier the client already knows itself by, the
 * second an implementation detail of soft delete.
 *
 * `position` is unpacked into two plain numbers because that is what a client
 * can use. Drizzle's `mode: 'xy'` mapper hands back `{ x, y }` — **x is
 * longitude** — and nothing outside this function should have to remember that.
 */
function toAddressResponse(row: AddressRow): Address {
  return {
    id: row.id,
    label: row.label,
    formattedAddress: row.formattedAddress,
    building: row.building,
    entrance: row.entrance,
    floor: row.floor,
    apartment: row.apartment,
    landmarkNote: row.landmarkNote,
    latitude: row.position.y,
    longitude: row.position.x,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
