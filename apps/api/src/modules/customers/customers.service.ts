import { Injectable } from '@nestjs/common';
import type { Customer } from '@tezusta/types';

import { requireVisibleOrNotFound } from '../../common/authorization/resource-visibility';
import { NotFoundError } from '../../common/errors/not-found.error';
import type { CustomerRow } from '../../infra/database/schema/customers';
import type { Actor } from '../auth/auth.types';
import type { CreateCustomerRequest, UpdateCustomerRequest } from './customers.schema';
import { CustomersRepository } from './customers.repository';

/** What the controller needs to answer 201 on a create and 200 on a repeat. */
export interface CustomerUpsertResult {
  readonly customer: Customer;
  readonly created: boolean;
}

/**
 * Customer profiles: the rules around the rows, and the mapping to the wire
 * contract.
 *
 * **Every method takes the `Actor` and derives the target from it.** None of
 * them accepts a user id from the request, because a handler that can be asked
 * "whose profile?" is a handler that can be asked the wrong name for it. The
 * one id-addressed read, {@link getById}, resolves the row first and then asks
 * whether this actor may see it — which is the only order that cannot be got
 * wrong.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly customers: CustomersRepository) {}

  async createOrRevive(actor: Actor, input: CreateCustomerRequest): Promise<CustomerUpsertResult> {
    const { customer, created } = await this.customers.createOrRevive({
      userId: actor.userId,
      displayName: input.displayName,
    });
    return { customer: toCustomerResponse(customer), created };
  }

  /**
   * The caller's own profile, or `undefined` when they have none.
   *
   * The nullable half of {@link getOwn}, for the one caller that is not asking
   * "show me my profile" but "is this actor this order's customer?"
   * (`orders.service.ts#transition`). A route open to both a customer and a
   * master has to be able to ask that question of a caller who legitimately
   * has no customer profile at all, and a 404 thrown mid-question would answer
   * a different one.
   *
   * Kept beside `getOwn` rather than reaching into `CustomersRepository` from
   * `modules/orders`: a module owns its data, and cross-module reads go
   * through the owning module's service
   * (`docs/architecture/backend-architecture.md` § Module rules).
   */
  async findOwn(actor: Actor): Promise<Customer | undefined> {
    const row = await this.customers.findByUserId(actor.userId);
    return row === undefined ? undefined : toCustomerResponse(row);
  }

  async getOwn(actor: Actor): Promise<Customer> {
    const row = await this.customers.findByUserId(actor.userId);
    if (row === undefined) {
      // The caller is authenticated and asking about themselves, so there is
      // no existence to protect here — but the answer is still 404, because
      // "you have no customer profile" and "your customer profile is gone"
      // are the same fact and the client's next move is the same either way:
      // POST /customers.
      throw new NotFoundError();
    }
    return toCustomerResponse(row);
  }

  /**
   * The ownership-checked read. Today the only actor a profile is visible to
   * is its own owner; a master is shown a customer's name through the order
   * they were assigned, not by reading this endpoint with an id they guessed
   * (`docs/engineering/security.md` § PII and privacy).
   *
   * `requireVisibleOrNotFound` is what keeps "not yours" and "does not exist"
   * indistinguishable. Two separate checks would be two correct-looking lines
   * that together turn this route into an oracle for which customer ids exist
   * (`docs/architecture/authentication.md` § Server ownership checks).
   */
  async getById(actor: Actor, id: string): Promise<Customer> {
    const row = requireVisibleOrNotFound(
      await this.customers.findById(id),
      (candidate) => candidate.userId === actor.userId,
    );
    return toCustomerResponse(row);
  }

  async updateOwn(actor: Actor, patch: UpdateCustomerRequest): Promise<Customer> {
    const row = await this.customers.updateByUserId(actor.userId, patch);
    if (row === undefined) {
      throw new NotFoundError();
    }
    return toCustomerResponse(row);
  }

  async deleteOwn(actor: Actor): Promise<void> {
    const deleted = await this.customers.softDeleteByUserId(actor.userId);
    if (!deleted) {
      throw new NotFoundError();
    }
  }
}

/**
 * The row-to-contract projection, in one place.
 *
 * Written as an explicit field list rather than a spread with deletions: a
 * column added to the table later — an internal note, a moderation flag — must
 * not reach a client because nobody remembered to exclude it. Listing what
 * goes out means the default for anything new is that it does not.
 *
 * `deletedAt` and `userId` are the two that matter most and neither appears:
 * the first is an implementation detail of soft delete, and the second is a
 * second identifier for a person the client already identifies as `me`.
 */
function toCustomerResponse(row: CustomerRow): Customer {
  return {
    id: row.id,
    displayName: row.displayName,
    avatarKey: row.avatarKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
