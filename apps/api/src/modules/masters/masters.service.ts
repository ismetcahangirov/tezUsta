import { Injectable } from '@nestjs/common';
import type { Master, MasterService as MasterServiceContract } from '@tezusta/types';

import { requireVisibleOrNotFound } from '../../common/authorization/resource-visibility';
import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import type {
  MasterRow,
  MasterServiceRow,
  MasterVerificationStatusName,
} from '../../infra/database/schema/masters';
import type { ServicePricingKindName, ServiceRow } from '../../infra/database/schema/services';
import type { Actor } from '../auth/auth.types';
import type {
  AddMasterServiceRequest,
  CreateMasterRequest,
  UpdateMasterRequest,
  UpdateMasterServiceRequest,
} from './masters.schema';
import { MastersRepository } from './masters.repository';

/** What the controller needs to answer 201 on a create and 200 on a repeat. */
export interface MasterUpsertResult {
  readonly master: Master;
  readonly created: boolean;
}

/**
 * The master already offers this catalogue service.
 *
 * 409 rather than 422: the request is well-formed and describes a state the
 * world is already in, which is a conflict, not a malformed body.
 */
export class ServiceAlreadyOfferedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.CONFLICT,
      'You already offer this service. Update it instead of adding it again.',
      409,
    );
    this.name = 'ServiceAlreadyOfferedError';
    Object.setPrototypeOf(this, ServiceAlreadyOfferedError.prototype);
  }
}

/**
 * The service exists in the catalogue but has been deactivated.
 *
 * Deliberately **not** a 404. The catalogue is public
 * ([ADR-0020](docs/decisions/ADR-0020-public-cached-service-catalogue.md)), so
 * there is no existence to protect, and "this service is retired" is a
 * different problem from "no such service" — one means the master's app is
 * stale, the other means it sent a wrong id.
 */
export class InactiveServiceError extends AppError {
  constructor() {
    super(ERROR_CODES.CONFLICT, 'That service is no longer offered on TezUsta.', 409);
    this.name = 'InactiveServiceError';
    Object.setPrototypeOf(this, InactiveServiceError.prototype);
  }
}

/**
 * A price was sent for an inspection-priced service, or withheld from a
 * fixed-price one.
 *
 * 422 with the pricing kind in `details`, because the client can fix this: it
 * knows the catalogue, so it can render the right form. The message never
 * guesses which of the two happened — `details.pricingKind` says what the
 * service is, and the client compares.
 */
export class PriceShapeMismatchError extends AppError {
  constructor(pricingKind: ServicePricingKindName) {
    super(
      ERROR_CODES.VALIDATION_FAILED,
      pricingKind === 'fixed'
        ? 'This service needs a price. Set what you charge for it.'
        : 'This service is priced after inspection, so it cannot carry a price in advance.',
      422,
      { pricingKind },
    );
    this.name = 'PriceShapeMismatchError';
    Object.setPrototypeOf(this, PriceShapeMismatchError.prototype);
  }
}

/**
 * The master may not take work in their current state.
 *
 * One error for every ineligible status rather than one per status, with the
 * status in `details` so the app can say the right thing — "waiting on review"
 * and "suspended" are different screens
 * (`docs/product/master-flow.md`), and the client is the place that knows
 * which screen it has.
 *
 * 409 rather than 403: the caller is who they say they are and is allowed to
 * ask, but the platform is in a state where the answer is no. A 403 would read
 * as "not your account".
 */
export class MasterNotEligibleError extends AppError {
  constructor(verificationStatus: string) {
    super(
      ERROR_CODES.CONFLICT,
      verificationStatus === 'suspended'
        ? 'Your account is suspended, so you cannot take work.'
        : 'Your profile has not been verified yet, so you cannot take work.',
      409,
      { verificationStatus },
    );
    this.name = 'MasterNotEligibleError';
    Object.setPrototypeOf(this, MasterNotEligibleError.prototype);
  }
}

/**
 * Master profiles and the catalogue services a master offers.
 *
 * **Every method takes the `Actor` and derives the target from it.** None of
 * them accepts a user or master id from the request body, because a handler
 * that can be asked "whose profile?" is a handler that can be asked the wrong
 * name for it. The one id-addressed read, {@link getById}, resolves the row
 * first and then asks whether this actor may see it — the only order that
 * cannot be got wrong.
 *
 * **Nothing here consults `verification_status`.** Managing a profile and
 * listing what you can do is preparation; the gate is on *accepting work* and
 * on going online (issues #39 and #40), and it is read from the database at
 * that moment rather than inferred from the fact that a row exists. A master
 * waiting on review can therefore set their prices up in advance, and still
 * receives no offers until an admin approves them.
 */
@Injectable()
export class MastersService {
  constructor(private readonly masters: MastersRepository) {}

  async createOrRevive(actor: Actor, input: CreateMasterRequest): Promise<MasterUpsertResult> {
    const { master, created } = await this.masters.createOrRevive({
      userId: actor.userId,
      displayName: input.displayName,
      bio: input.bio,
    });
    return { master: toMasterResponse(master), created };
  }

  /**
   * The caller's own profile, or `undefined` when they have none.
   *
   * The nullable half of {@link getOwn}, for the one caller that is not asking
   * "show me my profile" but "is this actor the master this order was assigned
   * to?" (`orders.service.ts#transition`). That route serves customers as well
   * as masters, so it has to be able to ask the question of a caller who
   * legitimately has no master profile — and a 404 thrown mid-question would
   * answer a different one.
   *
   * Kept beside `getOwn` rather than reaching into `MastersRepository` from
   * `modules/orders`: a module owns its data, and cross-module reads go
   * through the owning module's service
   * (`docs/architecture/backend-architecture.md` § Module rules).
   */
  /**
   * The accounts behind a set of master profiles (#144).
   *
   * No `Actor`, for the reason `CustomersService.findUserId` gives: the caller
   * is the notification raiser rather than a request. Batched, because a
   * broadcast wave resolves a whole round at once and one query per master
   * would be an N+1 on the dispatch path (CLAUDE.md §12).
   */
  async findUserIds(masterIds: readonly string[]): Promise<Map<string, string>> {
    return this.masters.findUserIdsByIds(masterIds);
  }

  /** What a customer calls this master, for a message push (#180). See `CustomersService.findDisplayName`. */
  async findDisplayName(masterId: string): Promise<string | undefined> {
    return this.masters.findDisplayNameById(masterId);
  }

  async findOwn(actor: Actor): Promise<Master | undefined> {
    const row = await this.masters.findByUserId(actor.userId);
    return row === undefined ? undefined : toMasterResponse(row);
  }

  async getOwn(actor: Actor): Promise<Master> {
    return toMasterResponse(await this.requireOwnProfile(actor));
  }

  /**
   * The ownership-checked read. Today a master profile is visible only to its
   * owner: a customer browsing for help is shown masters through matching and
   * an order, not by reading this endpoint with an id they guessed
   * (`docs/engineering/security.md` § PII and privacy). A public master
   * profile is a decision for the Epic that needs one.
   */
  async getById(actor: Actor, id: string): Promise<Master> {
    const row = requireVisibleOrNotFound(
      await this.masters.findById(id),
      (candidate) => candidate.userId === actor.userId,
    );
    return toMasterResponse(row);
  }

  async updateOwn(actor: Actor, patch: UpdateMasterRequest): Promise<Master> {
    const row = await this.masters.updateByUserId(actor.userId, patch);
    if (row === undefined) {
      throw new NotFoundError();
    }
    return toMasterResponse(row);
  }

  async deleteOwn(actor: Actor): Promise<void> {
    const deleted = await this.masters.softDeleteByUserId(actor.userId);
    if (!deleted) {
      throw new NotFoundError();
    }
  }

  async listServices(actor: Actor): Promise<MasterServiceContract[]> {
    const master = await this.requireOwnProfile(actor);
    const rows = await this.masters.listServices(master.id);
    return rows.map(toMasterServiceResponse);
  }

  async addService(actor: Actor, input: AddMasterServiceRequest): Promise<MasterServiceContract> {
    const master = await this.requireOwnProfile(actor);
    const service = await this.requireOfferableService(input.serviceId);

    assertPriceMatchesPricingKind(service.pricingKind, input.priceMinor ?? null);

    const row = await this.masters.addService({
      masterId: master.id,
      serviceId: input.serviceId,
      priceMinor: input.priceMinor ?? null,
      isActive: input.isActive ?? true,
    });

    if (row === undefined) {
      throw new ServiceAlreadyOfferedError();
    }
    return toMasterServiceResponse(row);
  }

  /**
   * Changing the price or pausing an offer.
   *
   * The pricing-shape rule is re-checked against the **resulting** price
   * rather than the submitted patch: a PATCH that omits `priceMinor` must not
   * be able to turn a priced fixed service into an unpriced one, and a PATCH
   * that sends `null` must be refused for exactly that service. Checking the
   * patch alone would let the second one through whenever the first field
   * happened to be absent.
   */
  async updateService(
    actor: Actor,
    serviceId: string,
    patch: UpdateMasterServiceRequest,
  ): Promise<MasterServiceContract> {
    const master = await this.requireOwnProfile(actor);

    const existing = await this.masters.findService(master.id, serviceId);
    if (existing === undefined) {
      throw new NotFoundError();
    }

    const service = await this.requireOfferableService(serviceId);
    const resultingPrice = patch.priceMinor === undefined ? existing.priceMinor : patch.priceMinor;
    assertPriceMatchesPricingKind(service.pricingKind, resultingPrice);

    const row = await this.masters.updateService(master.id, serviceId, patch);
    if (row === undefined) {
      // The row was there a moment ago; a concurrent DELETE is the only way
      // here, and "it is gone" is the honest answer to that race.
      throw new NotFoundError();
    }
    return toMasterServiceResponse(row);
  }

  async removeService(actor: Actor, serviceId: string): Promise<void> {
    const master = await this.requireOwnProfile(actor);
    const removed = await this.masters.removeService(master.id, serviceId);
    if (!removed) {
      throw new NotFoundError();
    }
  }

  /**
   * The caller's own live profile, or 404.
   *
   * Every `/masters/me/...` route needs this, and the answer to "you have no
   * master profile" is the same as to "your profile is gone": 404, and the
   * client's next move is `POST /masters` either way.
   */
  /**
   * The gate: may this master take work right now?
   *
   * **Re-read from the database, every time, at the moment it matters.** This
   * is the whole of issue #39's "a suspended master cannot accept, even with a
   * token issued before suspension". An access token lives up to fifteen
   * minutes and carries roles, not verification status; a check against the
   * claim would keep a suspended master working until their token expired,
   * which is fifteen minutes of somebody the platform has decided should not be
   * in a customer's home.
   *
   * Throws rather than returning a boolean, so a caller cannot ignore the
   * answer by forgetting an `if`. EPIC 7 calls it in the accept path and issue
   * #40 calls it before a master goes online — the two places where the answer
   * changes what happens.
   *
   * A soft-deleted profile reads as absent, which is a 404 rather than a
   * "not verified": there is nobody to verify.
   */
  async assertCanAcceptWork(masterId: string): Promise<MasterRow> {
    const master = await this.masters.findById(masterId);
    if (master === undefined) {
      throw new NotFoundError();
    }
    if (master.verificationStatus !== 'active') {
      throw new MasterNotEligibleError(master.verificationStatus);
    }
    return master;
  }

  /**
   * The review queue, for the admin surface (issue #39).
   *
   * Named `ForModeration` and returning rows rather than the `Master` wire
   * contract, because the admin module shapes its own responses and needs
   * fields — `userId` for session revocation — that no customer-facing
   * contract carries.
   *
   * It lives here rather than in the admin module because **table access stays
   * in the module that owns the table** (`docs/architecture/backend-architecture.md`
   * § Module rules, and the comment on `CustomersModule`: export the service,
   * never the repository). The admin module owns the *policy* — which
   * transitions are legal, what gets audited, who may act — and this owns the
   * SQL. A column rename then breaks one module, at a typed method, instead of
   * two.
   */
  async listForModeration(input: {
    status?: MasterVerificationStatusName | undefined;
    cursor?: string | undefined;
    limit: number;
  }): Promise<MasterRow[]> {
    return this.masters.listForReview(input);
  }

  /**
   * One master, by id, with no ownership check.
   *
   * Deliberately separate from {@link getById}, which answers 404 for a
   * profile that is not the caller's. An admin legitimately reads any master,
   * and the two must not be one method with a flag — a flag is one wrong
   * argument away from turning the ownership check off on a customer-facing
   * route.
   */
  async findForModeration(masterId: string): Promise<MasterRow | undefined> {
    return this.masters.findById(masterId);
  }

  /**
   * The min/max price among masters currently eligible to be offered
   * `serviceId` — `ServicesService`'s read for issue #84's indicative price
   * range.
   *
   * Exported from this service rather than left to `ServicesController` to
   * read `MastersRepository` directly, for the reason every cross-module read
   * in this codebase takes this shape
   * (`docs/architecture/backend-architecture.md` § Module rules): the table
   * belongs to this module, so a column rename here should break one typed
   * method in one module, not a query written into a stranger's.
   *
   * See `MastersRepository.getEligiblePriceRange` for what "eligible" means
   * today and why it is not yet the broadcast's real predicate.
   */
  async getEligiblePriceRange(
    serviceId: string,
  ): Promise<{ minMinor: number; maxMinor: number } | null> {
    return this.masters.getEligiblePriceRange(serviceId);
  }

  private async requireOwnProfile(actor: Actor): Promise<MasterRow> {
    const row = await this.masters.findByUserId(actor.userId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    return row;
  }

  private async requireOfferableService(serviceId: string): Promise<ServiceRow> {
    const service = await this.masters.findCatalogueService(serviceId);
    if (service === undefined) {
      throw new NotFoundError();
    }
    if (!service.isActive) {
      throw new InactiveServiceError();
    }
    return service;
  }
}

/**
 * The pricing shape, enforced across two tables.
 *
 * `services_pricing_shape` guarantees the catalogue row is coherent, but the
 * master's own figure lives on a different table, so no CHECK can see both.
 * Duplicating `pricing_kind` into `master_services` to make one possible would
 * buy a constraint at the cost of a copy that drifts the first time an admin
 * changes a service's pricing shape. This function is the enforcement point
 * instead, and it is called on every write that can change either side.
 */
function assertPriceMatchesPricingKind(
  pricingKind: ServicePricingKindName,
  priceMinor: number | null,
): void {
  const priced = priceMinor !== null;
  if (priced !== (pricingKind === 'fixed')) {
    throw new PriceShapeMismatchError(pricingKind);
  }
}

/**
 * The row-to-contract projection, in one place.
 *
 * Written as an explicit field list rather than a spread with deletions: a
 * column added to the table later — an internal moderation note, a fraud score
 * — must not reach a client because nobody remembered to exclude it.
 *
 * `userId`, `deletedAt`, `ratingSum` and the raw `suspendedAt` handling are
 * the ones that matter. `userId` is a second identifier for a person the
 * client already identifies as `me`; `ratingSum` is an implementation detail
 * of how the average stays exact.
 */
function toMasterResponse(row: MasterRow): Master {
  return {
    id: row.id,
    displayName: row.displayName,
    bio: row.bio,
    verificationStatus: row.verificationStatus,
    suspendedAt: row.suspendedAt === null ? null : row.suspendedAt.toISOString(),
    isAvailable: row.isAvailable,
    ratingAverage: averageRating(row.ratingSum, row.ratingCount),
    ratingCount: row.ratingCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Null, not zero, for a master nobody has rated.
 *
 * A UI that renders "no reviews yet" as 0.0 out of 5 tells every customer that
 * every new master is the worst on the platform, which is both false and the
 * fastest way to ensure a new master never gets a first job.
 *
 * Two decimals: the sum and count are exact, so the rounding happens once, on
 * the way out, rather than accumulating in a stored average.
 */
function averageRating(sum: number, count: number): number | null {
  if (count === 0) {
    return null;
  }
  return Math.round((sum / count) * 100) / 100;
}

function toMasterServiceResponse(row: MasterServiceRow): MasterServiceContract {
  return {
    serviceId: row.serviceId,
    priceMinor: row.priceMinor,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
