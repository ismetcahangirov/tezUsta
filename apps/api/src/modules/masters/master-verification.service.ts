import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  MasterDocument,
  MasterDocumentDownload,
  MasterDocumentUpload,
  MasterVerificationSubmission,
} from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import { uuidV7 } from '../../common/ids/uuid-v7';
import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type {
  MasterDocumentRow,
  MasterDocumentTypeName,
  MasterVerificationHistoryRow,
} from '../../infra/database/schema/master-verification';
import type { MasterRow, MasterVerificationStatusName } from '../../infra/database/schema/masters';
import {
  IMAGE_SIGNATURE_BYTES,
  sniffImageContentType,
} from '../../infra/storage/image-content-type';
import { STORAGE_PROVIDER } from '../../infra/storage/storage.types';
import type { StorageProvider } from '../../infra/storage/storage.types';
import type { Actor } from '../auth/auth.types';
import { MastersRepository } from './masters.repository';
import type { PresignDocumentRequest } from './master-verification.schema';
import { MasterVerificationRepository } from './master-verification.repository';

/** ADR-0023: the set a master must have uploaded before review can start. */
const REQUIRED_DOCUMENT_TYPES: readonly MasterDocumentTypeName[] = [
  'id_card_front',
  'id_card_back',
  'selfie_with_id',
];

/** The statuses from which a master may still act on their own verification. */
const EDITABLE_STATUSES = new Set(['pending_verification', 'changes_requested', 'active']);

/**
 * The master's account state does not allow touching documents right now.
 *
 * Two cases, one answer: a `suspended` master is blocked from acting at all,
 * and a `rejected` one has no resubmission path — ADR-0023 is explicit that
 * rejection "is not a resubmission state; appeal is the path out". Letting
 * either upload would produce evidence nothing will ever look at, and a master
 * waiting on a review that is not coming.
 */
export class VerificationNotEditableError extends AppError {
  constructor(status: string) {
    super(
      ERROR_CODES.CONFLICT,
      status === 'suspended'
        ? 'Your account is suspended, so verification documents cannot be changed.'
        : 'This verification decision is final and cannot be changed by uploading again.',
      409,
      { verificationStatus: status },
    );
    this.name = 'VerificationNotEditableError';
    Object.setPrototypeOf(this, VerificationNotEditableError.prototype);
  }
}

/** Confirm was called for a document whose bytes are not in storage. */
export class UploadNotFoundInStorageError extends AppError {
  constructor() {
    super(
      ERROR_CODES.CONFLICT,
      'The file has not arrived yet. Upload it to the URL from the presign step, then confirm.',
      409,
    );
    this.name = 'UploadNotFoundInStorageError';
    Object.setPrototypeOf(this, UploadNotFoundInStorageError.prototype);
  }
}

/** Confirm was called twice, or on a document that is already evidence. */
export class UploadAlreadyConfirmedError extends AppError {
  constructor() {
    super(ERROR_CODES.CONFLICT, 'This upload has already been confirmed.', 409);
    this.name = 'UploadAlreadyConfirmedError';
    Object.setPrototypeOf(this, UploadAlreadyConfirmedError.prototype);
  }
}

/**
 * The object is over the cap.
 *
 * 422 rather than 413: `docs/architecture/backend-architecture.md` fixes the
 * status table this API answers from, and 413 is not in it. The numbers go in
 * `details` so the app can say "4.8 MB, limit 5 MB" rather than repeat a
 * sentence the master cannot act on.
 */
export class UploadTooLargeError extends AppError {
  constructor(sizeBytes: number, maxBytes: number) {
    super(ERROR_CODES.VALIDATION_FAILED, 'That file is too large. Send a smaller photo.', 422, {
      sizeBytes,
      maxBytes,
    });
    this.name = 'UploadTooLargeError';
    Object.setPrototypeOf(this, UploadTooLargeError.prototype);
  }
}

/**
 * The bytes are not what the upload said they were.
 *
 * Covers both halves of the check: not a recognised image at all, and a
 * recognised image of a different type than the URL was signed for. Neither
 * detail reaches the client — telling an uploader precisely which signature
 * was seen turns the endpoint into a file-format oracle, and the honest answer
 * to a master whose photo was rejected is the same either way.
 */
export class UploadContentMismatchError extends AppError {
  constructor() {
    super(
      ERROR_CODES.VALIDATION_FAILED,
      'That file is not a JPEG, PNG or WebP image, or does not match the type it was uploaded as.',
      422,
    );
    this.name = 'UploadContentMismatchError';
    Object.setPrototypeOf(this, UploadContentMismatchError.prototype);
  }
}

/** Submit-for-review with documents still missing. */
export class VerificationIncompleteError extends AppError {
  constructor(missingDocumentTypes: readonly MasterDocumentTypeName[]) {
    super(ERROR_CODES.CONFLICT, 'Some verification documents are still missing.', 409, {
      missingDocumentTypes: [...missingDocumentTypes],
    });
    this.name = 'VerificationIncompleteError';
    Object.setPrototypeOf(this, VerificationIncompleteError.prototype);
  }
}

/**
 * The master's own side of verification: uploading evidence and submitting it.
 *
 * Admin review — approve, reject, request more, suspend — is a **separate,
 * separately-guarded surface** and lives in issue #39, because
 * `docs/product/admin-flow.md` forbids putting an admin action on a
 * customer-facing route.
 *
 * The security model, in one place:
 *
 * - **Bytes never pass through the API.** The client PUTs directly to storage
 *   through a presigned URL ([ADR-0005](docs/decisions/ADR-0005-object-storage.md)).
 * - **The size cap is enforced at confirm, against `head()`.** Cloudflare R2 does
 *   not implement the S3 POST form-policy that would bind a range into the
 *   signature, so the cap cannot live there
 *   ([ADR-0024](docs/decisions/ADR-0024-presigned-upload-mechanism.md)). An
 *   oversized object is refused, deleted, and never becomes attachable.
 * - **The declared content type is a claim.** The leading bytes are read back
 *   and sniffed, and a file whose signature contradicts its declared type is
 *   rejected and deleted.
 * - **Keys are server-generated.** A client never supplies or even sees one, so
 *   there is no filename to traverse with and no key to guess at.
 * - **A presigned URL is made single-use by this server, not by S3.** AWS
 *   documents that a presigned URL works repeatedly until it expires; the
 *   conditional transition out of `awaiting_upload` is what allows exactly one
 *   confirm.
 */
@Injectable()
export class MasterVerificationService {
  private readonly logger = new Logger(MasterVerificationService.name);

  constructor(
    private readonly masters: MastersRepository,
    private readonly verification: MasterVerificationRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async presignUpload(actor: Actor, input: PresignDocumentRequest): Promise<MasterDocumentUpload> {
    const master = await this.requireEditableProfile(actor);

    // An abandoned presign for this type holds the one slot the partial unique
    // index allows, and may have bytes behind it that nothing will ever
    // confirm. Clear both before minting a replacement.
    const abandoned = await this.verification.findPendingUpload(master.id, input.documentType);
    if (abandoned !== undefined) {
      await this.verification.deletePendingUpload(abandoned.id);
      await this.storage.delete(abandoned.storageKey);
    }

    const { presignTtlSeconds, verificationDocumentMaxBytes } = this.config.storage;
    const storageKey = buildDocumentKey(master.id);

    const presigned = await this.storage.presignUpload({
      key: storageKey,
      contentType: input.contentType,
      ttlSeconds: presignTtlSeconds,
      maxBytes: verificationDocumentMaxBytes,
    });

    const row = await this.verification.createPendingUpload({
      masterId: master.id,
      documentType: input.documentType,
      storageKey,
      declaredContentType: input.contentType,
      presignExpiresAt: presigned.expiresAt,
    });

    return {
      documentId: row.id,
      uploadUrl: presigned.url,
      expiresAt: presigned.expiresAt.toISOString(),
      contentType: input.contentType,
      maxBytes: verificationDocumentMaxBytes,
    };
  }

  /**
   * Turns an uploaded object into evidence — or refuses it and removes it.
   *
   * The order of the checks is the design. Size comes first because it is one
   * `HeadObject` and rejects the expensive case before anything is read; the
   * sniff is a **ranged** GET of twelve bytes, so validating a 5 MB photograph
   * costs twelve bytes rather than five megabytes. Only then does the row
   * move, and only if nobody else moved it first.
   */
  async confirmUpload(actor: Actor, documentId: string): Promise<MasterDocument> {
    const master = await this.requireEditableProfile(actor);
    const document = await this.requireOwnDocument(master, documentId);

    if (document.status !== 'awaiting_upload') {
      throw new UploadAlreadyConfirmedError();
    }

    const head = await this.storage.head(document.storageKey);
    if (head === undefined) {
      throw new UploadNotFoundInStorageError();
    }

    const maxBytes = this.config.storage.verificationDocumentMaxBytes;
    if (head.sizeBytes > maxBytes) {
      await this.discard(document, 'oversize');
      throw new UploadTooLargeError(head.sizeBytes, maxBytes);
    }

    const prefix = await this.storage.readPrefix(document.storageKey, IMAGE_SIGNATURE_BYTES);
    const sniffed = prefix === undefined ? null : sniffImageContentType(prefix);
    if (sniffed === null || sniffed !== document.declaredContentType) {
      await this.discard(document, 'content-mismatch');
      throw new UploadContentMismatchError();
    }

    const confirmed = await this.verification.confirmUpload({
      masterId: master.id,
      documentId: document.id,
      documentType: document.documentType,
      sizeBytes: head.sizeBytes,
      verifiedContentType: sniffed,
      now: new Date(),
    });

    if (confirmed === undefined) {
      throw new UploadAlreadyConfirmedError();
    }

    // Outside the transaction on purpose: a storage delete cannot participate
    // in it, and an object that outlives its row is a cleanup problem, whereas
    // a row that outlives its object is a document an admin cannot open.
    for (const key of confirmed.supersededStorageKeys) {
      await this.storage.delete(key);
    }

    return toDocumentResponse(confirmed.row);
  }

  async listDocuments(actor: Actor): Promise<MasterDocument[]> {
    const master = await this.requireOwnProfile(actor);
    const rows = await this.verification.listLiveDocuments(master.id);
    return rows.map(toDocumentResponse);
  }

  /**
   * A short-lived read URL for one of the caller's own documents.
   *
   * The bucket is private and has no public URL, ever
   * ([ADR-0005](docs/decisions/ADR-0005-object-storage.md)), so this is the
   * only way to see the file — and it is issued per request, to the owner,
   * for a couple of minutes. An admin's equivalent read lands in issue #39
   * and is itself an audited action: a read is an action.
   */
  async presignDownload(actor: Actor, documentId: string): Promise<MasterDocumentDownload> {
    const master = await this.requireOwnProfile(actor);
    const document = await this.requireOwnDocument(master, documentId);

    if (document.status === 'awaiting_upload') {
      // There is nothing behind the key yet. A presigned GET for it would be
      // a URL that 404s, which reads to a client as a broken server.
      throw new NotFoundError();
    }

    const presigned = await this.storage.presignDownload({
      key: document.storageKey,
      ttlSeconds: this.config.storage.downloadTtlSeconds,
    });
    return { url: presigned.url, expiresAt: presigned.expiresAt.toISOString() };
  }

  /**
   * Withdraws a document.
   *
   * The row is superseded, never deleted — `docs/product/admin-flow.md` § "No
   * destructive deletes". The **object** behind it is deleted only while
   * nobody has reviewed it: a master who changes their mind about an
   * unreviewed upload should not leave their ID card in a bucket, but the
   * evidence behind a review decision has to outlive the decision.
   */
  async withdrawDocument(actor: Actor, documentId: string): Promise<void> {
    const master = await this.requireEditableProfile(actor);
    const document = await this.requireOwnDocument(master, documentId);

    const withdrawn = await this.verification.supersedeDocument(master.id, documentId, new Date());
    if (!withdrawn) {
      throw new NotFoundError();
    }

    if (document.status === 'awaiting_upload' || document.status === 'pending_review') {
      await this.storage.delete(document.storageKey);
    }
  }

  /**
   * Submits the evidence for review.
   *
   * **Idempotent.** A master already in `pending_verification` who taps submit
   * again gets the same success, and no history row: the audit trail records
   * transitions, and there is no transition from a status to itself — the
   * database refuses one, which is what keeps the trail meaningful rather than
   * full of taps.
   */
  async submitForReview(actor: Actor): Promise<MasterVerificationSubmission> {
    const master = await this.requireEditableProfile(actor);

    const live = await this.verification.listLiveDocuments(master.id);
    const present = new Set(
      live
        .filter((document) => document.status !== 'awaiting_upload')
        .map((document) => document.documentType),
    );
    const missing = REQUIRED_DOCUMENT_TYPES.filter((type) => !present.has(type));

    if (missing.length > 0) {
      throw new VerificationIncompleteError(missing);
    }

    if (master.verificationStatus === 'pending_verification') {
      return { submitted: true, missingDocumentTypes: [] };
    }

    if (master.verificationStatus === 'active') {
      const unreviewed = live.some((document) => document.status === 'pending_review');
      if (!unreviewed) {
        // Nothing has changed since the approval, so there is nothing to
        // review. Answering "submitted" without moving is the only safe
        // option: the alternative is that a verified master who taps this
        // by accident drops out of `active`, stops receiving work, and waits
        // on a queue for a re-review of documents an admin already approved.
        return { submitted: true, missingDocumentTypes: [] };
      }
      // There IS unreviewed evidence — a replaced ID card, say — so it has to
      // be looked at, and losing `active` in the meantime is the point.
      // Otherwise swapping in an unseen document would be a way to hold
      // verified standing on evidence nobody has read.
      await this.transitionTo(master, 'pending_verification');
      return { submitted: true, missingDocumentTypes: [] };
    }

    // `changes_requested`: the master was asked for something and has supplied
    // it. Back into the queue.
    await this.transitionTo(master, 'pending_verification');
    return { submitted: true, missingDocumentTypes: [] };
  }

  private async transitionTo(master: MasterRow, to: 'pending_verification'): Promise<void> {
    const moved = await this.verification.transitionStatus({
      masterId: master.id,
      from: master.verificationStatus,
      to,
      actor: { kind: 'master', userId: master.userId },
      now: new Date(),
    });

    if (moved === undefined) {
      // The status changed under us — an admin acted between the read and the
      // write. Their decision is the newer one and wins.
      throw new VerificationNotEditableError(master.verificationStatus);
    }
  }

  /**
   * A master's live documents, for the admin surface (issue #39).
   *
   * No actor, no ownership check: an admin reviews any master. The **audit**
   * of that read is the admin module's job, not this one's — auditing here
   * would mean this method could not be called by anything that is not an
   * admin action, and the master's own list would start writing admin audit
   * rows.
   */
  async listDocumentsForModeration(masterId: string): Promise<MasterDocumentRow[]> {
    return this.verification.listLiveDocuments(masterId);
  }

  async findDocumentForModeration(
    masterId: string,
    documentId: string,
  ): Promise<MasterDocumentRow | undefined> {
    return this.verification.findOwnDocument(masterId, documentId);
  }

  async listHistoryForModeration(
    masterId: string,
    limit: number,
  ): Promise<MasterVerificationHistoryRow[]> {
    return this.verification.listHistory(masterId, limit);
  }

  /**
   * Moves a master to a new status on an admin's authority, writing the
   * history row in the same transaction.
   *
   * **Which transitions are legal is not decided here.** That table is admin
   * policy and lives with the admin surface; this method's contract is
   * narrower and more useful: it applies the transition only if the master is
   * still in `from`, and returns `undefined` if they are not. Two admins
   * acting at once therefore produce one decision and one record, rather than
   * two records of which one is fiction.
   */
  async transitionByAdmin(input: {
    masterId: string;
    from: MasterVerificationStatusName;
    to: MasterVerificationStatusName;
    adminUserId: string;
    reason?: string | undefined;
    now: Date;
  }): Promise<MasterVerificationStatusName | undefined> {
    return this.verification.transitionStatus({
      masterId: input.masterId,
      from: input.from,
      to: input.to,
      actor: { kind: 'admin', adminUserId: input.adminUserId },
      reason: input.reason,
      now: input.now,
    });
  }

  /** Stamps a review decision onto every document that was waiting for one. */
  async reviewDocumentsForModeration(input: {
    masterId: string;
    toStatus: 'accepted' | 'rejected';
    adminUserId: string;
    now: Date;
  }): Promise<number> {
    return this.verification.reviewLiveDocuments(input);
  }

  private async requireOwnProfile(actor: Actor): Promise<MasterRow> {
    const row = await this.masters.findByUserId(actor.userId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    return row;
  }

  private async requireEditableProfile(actor: Actor): Promise<MasterRow> {
    const master = await this.requireOwnProfile(actor);
    if (!EDITABLE_STATUSES.has(master.verificationStatus)) {
      throw new VerificationNotEditableError(master.verificationStatus);
    }
    return master;
  }

  /**
   * Resolve-then-authorize, in the one order that cannot be got wrong.
   *
   * The repository already scopes the query by master id, so this cannot
   * return a stranger's row; the 404 is for a document id that names nothing
   * *of the caller's*, which is deliberately the same answer as one that names
   * nothing at all (`docs/architecture/authentication.md` § Server ownership
   * checks). Another master's document id must not be distinguishable from a
   * random uuid, or the endpoint becomes an oracle for which documents exist.
   */
  private async requireOwnDocument(
    master: MasterRow,
    documentId: string,
  ): Promise<MasterDocumentRow> {
    const row = await this.verification.findOwnDocument(master.id, documentId);
    if (row === undefined) {
      throw new NotFoundError();
    }
    return row;
  }

  /**
   * Removes an object that failed validation, and **keeps the row**.
   *
   * The object goes because a rejected upload must not survive the request
   * that rejected it: otherwise the bucket slowly fills with files the
   * platform already decided it would not accept, including whatever somebody
   * was trying to store there by mislabelling it.
   *
   * The row stays, still `awaiting_upload`, and that is the deliberate half.
   * The presigned URL does not stop working because we rejected what arrived
   * through it — storage has no idea a confirm happened — so deleting the row
   * too would leave a live URL pointing at a key nothing references, and a
   * client retrying the PUT would strand an object no later request could ever
   * find or clean. Keeping the row means the retry lands on a key we still
   * know about: the master can re-send a smaller or correctly-typed photo to
   * the same URL, and whatever is left when they give up is cleared by their
   * next presign.
   *
   * The reason is logged with the master id and never with the key or the
   * declared type — a storage key is a capability, and a log is not the place
   * for one (`docs/engineering/security.md` § Logging).
   */
  private async discard(document: MasterDocumentRow, reason: string): Promise<void> {
    await this.storage.delete(document.storageKey);
    this.logger.warn(
      `verification upload rejected (${reason}) for master ${document.masterId}, type ${document.documentType}`,
    );
  }
}

/**
 * The object key for one document.
 *
 * Server-generated from the master id and a fresh UUIDv7 — **never** a client
 * filename, which is the path-traversal control ADR-0005 names. The master id
 * prefix is not a security boundary (the bucket is private and every read goes
 * through a presigned GET this service issues); it is there so that an
 * operator looking at storage can tell whose file they are looking at without
 * a database, which matters on the day somebody has to delete a person's data.
 */
function buildDocumentKey(masterId: string): string {
  return `masters/${masterId}/verification/${uuidV7()}`;
}

/**
 * The row-to-contract projection.
 *
 * `storageKey`, `declaredContentType` and `verifiedContentType` are all
 * deliberately absent. The key is a server-side capability; the two content
 * types are how the server decided, and a client that could read back what
 * the sniffer found would have a probe for exactly what the check accepts.
 */
function toDocumentResponse(row: MasterDocumentRow): MasterDocument {
  return {
    id: row.id,
    documentType: row.documentType,
    status: row.status,
    sizeBytes: row.sizeBytes,
    submittedAt: row.submittedAt === null ? null : row.submittedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
