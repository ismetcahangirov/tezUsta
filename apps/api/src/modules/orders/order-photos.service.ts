import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OrderPhoto, OrderPhotoDownload, OrderPhotoUpload, OrderStatus } from '@tezusta/types';

import { requireVisibleOrNotFound } from '../../common/authorization/resource-visibility';
import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import { uuidV7 } from '../../common/ids/uuid-v7';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { OrderPhotoRow } from '../../infra/database/schema/order-photos';
import type { OrderRow } from '../../infra/database/schema/orders';
import {
  IMAGE_SIGNATURE_BYTES,
  sniffImageContentType,
} from '../../infra/storage/image-content-type';
import { STORAGE_PROVIDER } from '../../infra/storage/storage.types';
import type { StorageProvider } from '../../infra/storage/storage.types';
import type { Actor } from '../auth/auth.types';
import { CustomersService } from '../customers/customers.service';
import { MasterNotEligibleError, MastersService } from '../masters/masters.service';
import type { AttachOutcome } from './order-photos.repository';
import { OrderPhotosRepository } from './order-photos.repository';
import type { AttachOrderPhotoRequest, PresignOrderPhotoRequest } from './order-photos.schema';
import { OrdersRepository } from './orders.repository';

/** Confirm was called for a photo whose bytes are not in storage yet. */
export class PhotoUploadNotFoundInStorageError extends AppError {
  constructor() {
    super(
      ERROR_CODES.CONFLICT,
      'The photo has not arrived yet. Upload it to the URL from the presign step, then confirm.',
      409,
    );
    this.name = 'PhotoUploadNotFoundInStorageError';
    Object.setPrototypeOf(this, PhotoUploadNotFoundInStorageError.prototype);
  }
}

/** Confirm was called twice, or on a photo that is already confirmed or attached. */
export class PhotoAlreadyConfirmedError extends AppError {
  constructor() {
    super(ERROR_CODES.CONFLICT, 'This upload has already been confirmed.', 409);
    this.name = 'PhotoAlreadyConfirmedError';
    Object.setPrototypeOf(this, PhotoAlreadyConfirmedError.prototype);
  }
}

/**
 * The object is over the configured cap. 422, not 413 — the same choice
 * `master-verification.service.ts`'s `UploadTooLargeError` makes, and for the
 * same reason: `docs/architecture/backend-architecture.md`'s status table has
 * no 413.
 */
export class PhotoTooLargeError extends AppError {
  constructor(sizeBytes: number, maxBytes: number) {
    super(ERROR_CODES.VALIDATION_FAILED, 'That photo is too large. Send a smaller photo.', 422, {
      sizeBytes,
      maxBytes,
    });
    this.name = 'PhotoTooLargeError';
    Object.setPrototypeOf(this, PhotoTooLargeError.prototype);
  }
}

/**
 * The bytes are not what the upload said they were. The same phrasing as
 * `UploadContentMismatchError` and for the same reason: which signature was
 * actually seen is not told to the client, or the endpoint becomes a
 * file-format oracle.
 */
export class PhotoContentMismatchError extends AppError {
  constructor() {
    super(
      ERROR_CODES.VALIDATION_FAILED,
      'That file is not a JPEG, PNG or WebP image, or does not match the type it was uploaded as.',
      422,
    );
    this.name = 'PhotoContentMismatchError';
    Object.setPrototypeOf(this, PhotoContentMismatchError.prototype);
  }
}

/** Attach was called before confirm — there is nothing ready to attach yet. */
export class PhotoNotConfirmedError extends AppError {
  constructor() {
    super(
      ERROR_CODES.CONFLICT,
      'This photo has not finished uploading yet. Confirm it before attaching it to an order.',
      409,
    );
    this.name = 'PhotoNotConfirmedError';
    Object.setPrototypeOf(this, PhotoNotConfirmedError.prototype);
  }
}

/**
 * The photo is already attached — to this order or another one. One error
 * either way: which order it is already on is not told to the client, the
 * same reasoning `NotFoundError` gives for "not yours" versus "does not
 * exist" — the fact that matters is that this attach cannot happen.
 */
export class PhotoAlreadyAttachedError extends AppError {
  constructor() {
    super(ERROR_CODES.CONFLICT, 'This photo has already been attached to an order.', 409);
    this.name = 'PhotoAlreadyAttachedError';
    Object.setPrototypeOf(this, PhotoAlreadyAttachedError.prototype);
  }
}

/**
 * The statuses in which attaching a problem photo is plainly part of the
 * job: the order is still being found a master, or a master is already
 * working it.
 *
 * **Deliberately narrower than "any non-terminal status."** Whether a
 * customer may add evidence to a `DISPUTED` order is a real question — it
 * cuts the other way from every status here, where a photo is evidence
 * *for* the work, not evidence *about* a disagreement — and it belongs to
 * EPIC 8's dispute handling, which owns the rules for what a dispute may be
 * supported with. This set answers only "is photographing the problem still
 * something this order is doing," not that harder question, and does not
 * pretend to.
 */
const ATTACHABLE_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'SEARCHING',
  'ACCEPTED',
  'MASTER_ON_THE_WAY',
  'MASTER_ARRIVED',
  'IN_PROGRESS',
]);

/** The order is not in a status that still accepts new problem photos. */
export class OrderNotAcceptingPhotosError extends AppError {
  constructor(status: OrderStatus) {
    super(ERROR_CODES.CONFLICT, 'This order is no longer accepting new photos.', 409, { status });
    this.name = 'OrderNotAcceptingPhotosError';
    Object.setPrototypeOf(this, OrderNotAcceptingPhotosError.prototype);
  }
}

/** The order already carries the configured maximum number of photos. */
export class OrderPhotoLimitExceededError extends AppError {
  constructor(maxPhotos: number) {
    super(
      ERROR_CODES.ORDER_PHOTO_LIMIT_EXCEEDED,
      `An order may carry at most ${String(maxPhotos)} photos.`,
      409,
      { maxPhotos },
    );
    this.name = 'OrderPhotoLimitExceededError';
    Object.setPrototypeOf(this, OrderPhotoLimitExceededError.prototype);
  }
}

/**
 * Order problem photos (issue #83) — presign, confirm, and attach — built on
 * the exact mechanism `MasterVerificationService` shipped for verification
 * documents. Read that file's class comment first; the security model here is
 * the same one, with two differences this file's methods exist to express:
 *
 * - **A photo is issued to a customer, not to an order.** There is no order
 *   to scope a presign to — a customer photographs the problem before
 *   deciding whether to submit a request at all — so ownership is checked
 *   against the *customer*, and attaching to an order is a separate,
 *   explicit step. `docs/product/customer-flow.md` requires that an order
 *   still be creatable with no photos at all; keeping upload and order
 *   creation as two independent paths is what makes that trivially true
 *   rather than a special case `OrdersService.create` has to carry.
 * - **A photo, once attached, is visible to a second party** — the master
 *   assigned to the order, not only the issuing customer — so reads resolve
 *   visibility from the order's `customer_id` *and* `master_id`, rather than
 *   the single-owner check verification documents use. That second check is
 *   gated on `MastersService#assertCanAcceptWork`, not merely on holding a
 *   master profile: a master an admin has since suspended keeps a `master_id`
 *   on whatever order they were assigned to at the time, and without this
 *   gate would keep minting presigned read URLs for a photograph of that
 *   customer's home after the platform decided they should not be in it.
 *
 * The assigned-master path cannot be driven end-to-end today: no order can
 * reach an assigned master until EPIC 7 ships dispatch and accept. The check
 * below is written and tested against `orders.master_id` directly — a column
 * that already exists or this issue's `orders_one_active_per_master` guard
 * partner would have nothing to reference — so the day accept sets it for
 * real, no code here changes.
 */
@Injectable()
export class OrderPhotosService {
  private readonly logger = new Logger(OrderPhotosService.name);

  constructor(
    private readonly photos: OrderPhotosRepository,
    private readonly orders: OrdersRepository,
    private readonly customers: CustomersService,
    private readonly masters: MastersService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Mints a presigned upload — clearing the customer's previous, abandoned
   * one first.
   *
   * `order_photos_pending_upload_unique` allows exactly one row in
   * `awaiting_upload` per customer, so a second presign without this would
   * fail the constraint rather than replace the first. It also bounds the
   * real exposure: a presigned PUT binds no size (ADR-0024 §3), so every
   * outstanding one is a live write capability into a billed bucket for the
   * rest of its TTL, and without a per-customer bound the `document-upload`
   * rate limit alone would still allow thirty of them live at once.
   */
  async presignUpload(actor: Actor, input: PresignOrderPhotoRequest): Promise<OrderPhotoUpload> {
    const customer = await this.customers.getOwn(actor);

    const abandoned = await this.photos.findPendingUpload(customer.id);
    if (abandoned !== undefined) {
      await this.photos.deletePendingUpload(abandoned.id);
      await this.storage.delete(abandoned.storageKey);
    }

    const { presignTtlSeconds, orderPhotoMaxBytes } = this.config.storage;
    const storageKey = buildPhotoKey(customer.id);

    const presigned = await this.storage.presignUpload({
      key: storageKey,
      contentType: input.contentType,
      ttlSeconds: presignTtlSeconds,
      maxBytes: orderPhotoMaxBytes,
    });

    const row = await this.photos.createPendingUpload({
      customerId: customer.id,
      storageKey,
      declaredContentType: input.contentType,
      presignExpiresAt: presigned.expiresAt,
    });

    return {
      photoId: row.id,
      uploadUrl: presigned.url,
      expiresAt: presigned.expiresAt.toISOString(),
      contentType: input.contentType,
      maxBytes: orderPhotoMaxBytes,
    };
  }

  /**
   * Turns an uploaded object into a confirmed photo — or refuses it and
   * removes it. Same order of checks, and the same reasoning, as
   * `MasterVerificationService#confirmUpload`: size first (one `HeadObject`,
   * rejects the expensive case before anything is read), then a twelve-byte
   * ranged sniff, then — only if both pass — the conditional transition.
   */
  async confirmUpload(actor: Actor, photoId: string): Promise<OrderPhoto> {
    const customer = await this.customers.getOwn(actor);
    const photo = await this.requireOwnPhoto(customer.id, photoId);

    if (photo.status !== 'awaiting_upload') {
      throw new PhotoAlreadyConfirmedError();
    }

    const head = await this.storage.head(photo.storageKey);
    if (head === undefined) {
      throw new PhotoUploadNotFoundInStorageError();
    }

    const maxBytes = this.config.storage.orderPhotoMaxBytes;
    if (head.sizeBytes > maxBytes) {
      await this.discard(photo, 'oversize');
      throw new PhotoTooLargeError(head.sizeBytes, maxBytes);
    }

    const prefix = await this.storage.readPrefix(photo.storageKey, IMAGE_SIGNATURE_BYTES);
    const sniffed = prefix === undefined ? null : sniffImageContentType(prefix);
    if (sniffed === null || sniffed !== photo.declaredContentType) {
      await this.discard(photo, 'content-mismatch');
      throw new PhotoContentMismatchError();
    }

    const confirmed = await this.photos.confirmUpload({
      customerId: customer.id,
      photoId: photo.id,
      sizeBytes: head.sizeBytes,
      verifiedContentType: sniffed,
      now: new Date(),
    });

    if (confirmed === undefined) {
      throw new PhotoAlreadyConfirmedError();
    }

    return toPhotoResponse(confirmed);
  }

  /**
   * Attaches one of the caller's own confirmed photos to one of the caller's
   * own orders.
   *
   * **Ownership is checked twice, against two different rows, and neither
   * check can be skipped by naming the other correctly.** A photo id issued
   * to a stranger and an order id that belongs to a stranger both answer 404,
   * from `requireVisibleOrNotFound` and `requireOwnPhoto` respectively — a
   * caller cannot use a real order id they do own to learn anything about a
   * photo id they do not, or the other way round.
   *
   * **Only while the order is in {@link ATTACHABLE_ORDER_STATUSES}.** Without
   * this, a customer could attach to a `CANCELLED`, `COMPLETED`,
   * `NO_MASTER_FOUND`, `REFUNDED` or `RESOLVED` order — each attach bumping
   * `updated_at` on a row nothing else was ever going to touch again — which
   * is a product decision nobody made (CLAUDE.md §17), made anyway by simply
   * never checking. `DISPUTED` is deliberately not addressed by this gate;
   * see the set's own comment for why.
   */
  async attach(actor: Actor, orderId: string, input: AttachOrderPhotoRequest): Promise<OrderPhoto> {
    const customer = await this.customers.getOwn(actor);

    const order = requireVisibleOrNotFound(
      await this.orders.findById(orderId),
      (candidate) => candidate.customerId === customer.id,
    );

    if (!ATTACHABLE_ORDER_STATUSES.has(order.status)) {
      throw new OrderNotAcceptingPhotosError(order.status);
    }

    const photo = await this.requireOwnPhoto(customer.id, input.photoId);

    if (photo.status === 'awaiting_upload') {
      throw new PhotoNotConfirmedError();
    }
    if (photo.status === 'attached') {
      throw new PhotoAlreadyAttachedError();
    }

    const outcome: AttachOutcome = await this.photos.attach({
      orderId: order.id,
      customerId: customer.id,
      photoId: photo.id,
      maxPhotos: this.config.orders.maxPhotosPerOrder,
      now: new Date(),
    });

    switch (outcome.kind) {
      case 'attached':
        return toPhotoResponse(outcome.row);
      case 'limit_exceeded':
        throw new OrderPhotoLimitExceededError(this.config.orders.maxPhotosPerOrder);
      case 'already_attached':
        throw new PhotoAlreadyAttachedError();
    }
  }

  /** Every photo attached to an order — the owning customer's read, and the assigned master's. */
  async listForOrder(actor: Actor, orderId: string): Promise<OrderPhoto[]> {
    const order = await this.requireVisibleOrder(actor, orderId);
    const rows = await this.photos.listAttachedForOrder(order.id);
    return rows.map(toPhotoResponse);
  }

  /**
   * A short-lived read URL for one photo attached to one order.
   *
   * The bucket is private and has no public URL, ever (ADR-0005), so this is
   * the only way to see the file — issued per request, to a caller this order
   * is actually visible to, for a couple of minutes.
   */
  async presignDownload(
    actor: Actor,
    orderId: string,
    photoId: string,
  ): Promise<OrderPhotoDownload> {
    const order = await this.requireVisibleOrder(actor, orderId);
    const photo = await this.photos.findByOrderAndId(order.id, photoId);
    if (photo === undefined) {
      throw new NotFoundError();
    }

    const presigned = await this.storage.presignDownload({
      key: photo.storageKey,
      ttlSeconds: this.config.storage.downloadTtlSeconds,
    });
    return { url: presigned.url, expiresAt: presigned.expiresAt.toISOString() };
  }

  /**
   * Every photo attached to one order, as short-lived read URLs — for the
   * master-facing offer card (issue #101).
   *
   * **The same read path as {@link presignDownload}**, not a second one: the
   * same repository read, the same storage provider, the same
   * `downloadTtlSeconds`. What differs is only that an offer card carries the
   * whole set rather than one photo, because the alternative — handing a
   * master a list of photo ids to fetch one at a time — would put a round trip
   * per photo on the one screen a master reads while deciding whether to drive
   * across Baku.
   *
   * No actor and no ownership check, for `findPhotoForModeration`'s reason and
   * with a different authority: the caller has already established that this
   * master holds a **live offer** on this order, which the ordinary visibility
   * check cannot express — an offered master is by definition not yet the
   * order's `master_id`, and will never be if somebody else wins. Named so the
   * omission is visible at every call site.
   */
  async presignAttachedForOffer(orderId: string): Promise<OrderPhotoDownload[]> {
    const rows = await this.photos.listAttachedForOrder(orderId);
    return Promise.all(
      rows.map(async (row) => {
        const presigned = await this.storage.presignDownload({
          key: row.storageKey,
          ttlSeconds: this.config.storage.downloadTtlSeconds,
        });
        return { url: presigned.url, expiresAt: presigned.expiresAt.toISOString() };
      }),
    );
  }

  /**
   * One photo attached to one order, for the admin surface
   * (`admin-order-photos.service.ts`). No actor, no ownership check: an
   * admin's authority is the separate credential path
   * (ADR-0014), never a role flag on a customer-facing check. The audit of
   * this read is the admin module's job, not this one's — the same division
   * `MasterVerificationService#findDocumentForModeration` draws.
   */
  async findPhotoForModeration(
    orderId: string,
    photoId: string,
  ): Promise<OrderPhotoRow | undefined> {
    return this.photos.findByOrderAndId(orderId, photoId);
  }

  private async requireVisibleOrder(actor: Actor, orderId: string): Promise<OrderRow> {
    const [customerId, masterId] = await Promise.all([
      this.resolveOwnCustomerId(actor),
      this.resolveOwnMasterId(actor),
    ]);

    return requireVisibleOrNotFound(
      await this.orders.findById(orderId),
      (candidate) =>
        candidate.customerId === customerId ||
        (masterId !== undefined && candidate.masterId === masterId),
    );
  }

  private async resolveOwnCustomerId(actor: Actor): Promise<string | undefined> {
    try {
      return (await this.customers.getOwn(actor)).id;
    } catch (error) {
      if (error instanceof NotFoundError) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * The caller's own master id — **only while that master is eligible to
   * work**, not merely holding a profile.
   *
   * `masters.getOwn(actor)` alone would resolve a suspended master's id just
   * as happily as an active one's: a role claim in a token is a cache, not an
   * authority (`docs/architecture/authentication.md`), and the same is true
   * of a profile's mere existence. `assertCanAcceptWork` is the live,
   * re-read-from-the-database gate issue #39 built for exactly this
   * question — "may this master act right now" — and reusing it here rather
   * than inventing a second status check is what keeps a suspension actually
   * mean something everywhere a master's identity is used for authorization,
   * not only on the accept path it was written for.
   *
   * A suspended (or otherwise ineligible) master is treated exactly like a
   * master who was never assigned: this resolves to `undefined`, so
   * `requireVisibleOrNotFound` falls through to 404 rather than surfacing
   * `MasterNotEligibleError` — the caller asked to see an order's photos, not
   * to accept work, and the honest answer to "can you see this" is the same
   * 404 a stranger gets.
   */
  private async resolveOwnMasterId(actor: Actor): Promise<string | undefined> {
    let master;
    try {
      master = await this.masters.getOwn(actor);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return undefined;
      }
      throw error;
    }

    try {
      await this.masters.assertCanAcceptWork(master.id);
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof MasterNotEligibleError) {
        return undefined;
      }
      throw error;
    }

    return master.id;
  }

  /**
   * Resolve-then-authorize, in the one order that cannot be got wrong — same
   * reasoning as `MasterVerificationService#requireOwnDocument`. The
   * repository already scopes the query by customer id, so this cannot
   * return a stranger's row; the 404 is for a photo id that names nothing
   * *of the caller's*, which is deliberately the same answer as one that
   * names nothing at all. This is the whole "a key issued to another
   * customer cannot be attached" control: it answers 404, never 403, which
   * would confirm the key exists.
   */
  private async requireOwnPhoto(customerId: string, photoId: string): Promise<OrderPhotoRow> {
    const row = await this.photos.findOwnPhoto(customerId, photoId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    return row;
  }

  /**
   * Removes an object that failed validation, and **keeps the row** —
   * identical reasoning to `MasterVerificationService#discard`: the
   * presigned URL does not stop working because a confirm rejected what
   * arrived through it, so the row must survive to give a retry somewhere to
   * land.
   *
   * The reason is logged against the **photo id**, not the customer id — a
   * storage key is a capability and stays out for that reason, but a photo
   * row is a photograph of the inside of somebody's home, and its owning
   * customer is exactly the identifier a rejected-upload log should not
   * carry (`docs/engineering/security.md` § Logging). The photo id is
   * enough for an operator to look the row up if the pattern of rejections
   * ever needs investigating.
   */
  private async discard(photo: OrderPhotoRow, reason: string): Promise<void> {
    await this.storage.delete(photo.storageKey);
    this.logger.warn(`order photo upload rejected (${reason}) for photo ${photo.id}`);
  }
}

/**
 * The object key for one photo. Server-generated from the customer id and a
 * fresh UUIDv7 — never a client filename, the path-traversal control
 * ADR-0005 names — exactly `master-verification.service.ts#buildDocumentKey`,
 * scoped to `orders/photos/` instead of a master's verification folder.
 */
function buildPhotoKey(customerId: string): string {
  return `orders/photos/${customerId}/${uuidV7()}`;
}

/**
 * The row-to-contract projection. `storageKey`, `customerId`,
 * `declaredContentType` and `verifiedContentType` are all deliberately
 * absent — the key is a server-side capability, the customer id is a second
 * identifier for someone the client already knows as themselves, and the two
 * content types are how the server decided, not something a client should be
 * able to probe.
 */
function toPhotoResponse(row: OrderPhotoRow): OrderPhoto {
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    sizeBytes: row.sizeBytes,
    submittedAt: row.submittedAt === null ? null : row.submittedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
