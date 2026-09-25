import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { GeocodeCacheRepository } from '../../infra/geo/geocode-cache.repository';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import { RecurringWorkService } from '../../infra/queue/recurring-work.service';
import type { StorageProvider } from '../../infra/storage/storage.types';
import { STORAGE_PROVIDER } from '../../infra/storage/storage.types';
import { AdminRepository } from '../admin/admin.repository';
import { OtpRepository } from '../auth/otp.repository';
import { SessionsRepository } from '../auth/sessions.repository';
import { MasterLocationRepository } from '../masters/master-location.repository';
import { MasterVerificationRepository } from '../masters/master-verification.repository';
import { MessageAttachmentsRepository } from '../orders/message-attachments.repository';
import { OrderPhotosRepository } from '../orders/order-photos.repository';
import {
  AUTH_RETENTION_JOB,
  GEOCODE_CACHE_SWEEP_JOB,
  MAINTENANCE_JOBS,
  MASTER_DOCUMENT_SWEEP_JOB,
  MASTER_LOCATION_SWEEP_JOB,
  MAX_BATCHES_PER_RUN,
  ORDER_PHOTO_SWEEP_JOB,
  OTP_CHALLENGE_SWEEP_JOB,
} from './maintenance.constants';

/**
 * The retention sweeps: expired refresh tokens and dead sessions, consumer and
 * admin alike (#57, #276), spent or never-redeemed OTP challenges (#276),
 * expired geocode cache rows (#69), confirmed-but-never-attached order photos
 * (#92) and, in the same job, message photos never sent (#181), verification documents presigned and never confirmed (#128), and the
 * position trails of masters who have stopped reporting (#105).
 *
 * Every one of them was filed as "needs a scheduler, and there is not one",
 * and every one waited for ADR-0025's queue rather than inventing a mechanism
 * of its own. They are together in one module because that is what they
 * share: not a domain — they touch tables across `AuthModule`, `OtpModule`,
 * `AdminModule`, `OrdersModule`, `MastersModule` and the geocoding
 * infrastructure — but a schedule, a batch size, and the rule that a sweep
 * must never be the reason a request path is slow.
 *
 * **Nothing here runs at boot.** A handler is registered (cheap, in-memory)
 * and a scheduler is upserted; the first iteration is one interval away,
 * because that is what `upsertJobScheduler` does with an `every` and because
 * issue #57 asks for it in as many words. A deploy touches no data on its way
 * up.
 *
 * **Every replica registers the same schedulers and that is correct.** The
 * scheduler is an upsert keyed by the job name, so N replicas leave one
 * scheduler behind, and each iteration it produces is an ordinary queued job
 * that exactly one worker in the fleet runs. That is the whole answer to
 * "safe to run on every instance concurrently" (#69) — there is no second
 * copy of the sweep to be safe about.
 *
 * **A sweep is idempotent by construction, not by promise.** Each one deletes
 * rows that are past a cutoff computed from the current time, so a second run
 * finds nothing and deletes nothing, and a retry after a partial failure
 * re-deletes whatever the first attempt did not reach and nothing else.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly handlers: DeferredJobHandlerRegistry,
    private readonly recurring: RecurringWorkService,
    private readonly sessions: SessionsRepository,
    private readonly otpChallenges: OtpRepository,
    private readonly admins: AdminRepository,
    private readonly geocodeCache: GeocodeCacheRepository,
    private readonly photos: OrderPhotosRepository,
    private readonly messagePhotos: MessageAttachmentsRepository,
    private readonly documents: MasterVerificationRepository,
    private readonly locations: MasterLocationRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Registered here rather than in `onApplicationBootstrap`, so the handlers
   * exist before any worker starts fetching. The registry throws on a
   * duplicate name, which is what turns "two modules both think they own this
   * job" into a boot failure instead of import-order-dependent behaviour.
   */
  onModuleInit(): void {
    this.handlers.register(AUTH_RETENTION_JOB, () => this.sweepAuthTokens());
    this.handlers.register(OTP_CHALLENGE_SWEEP_JOB, () => this.sweepOtpChallenges());
    this.handlers.register(GEOCODE_CACHE_SWEEP_JOB, () => this.sweepGeocodeCache());
    this.handlers.register(ORDER_PHOTO_SWEEP_JOB, () => this.sweepAbandonedPhotos());
    this.handlers.register(MASTER_DOCUMENT_SWEEP_JOB, () => this.sweepAbandonedDocuments());
    this.handlers.register(MASTER_LOCATION_SWEEP_JOB, () => this.sweepExpiredLocationTrails());
  }

  async onApplicationBootstrap(): Promise<void> {
    const minutes = this.config.maintenance.sweepIntervalMinutes;

    if (minutes === 0) {
      // Zero means disabled, and disabled has to mean the scheduler is gone —
      // otherwise one left behind by an earlier release keeps producing jobs
      // nobody asked for. `stop` on a scheduler that was never created is a
      // no-op. (A fleet part-way through a rollout with the flag set two
      // different ways will fight over this; the flag is deployment-wide.)
      await Promise.all(MAINTENANCE_JOBS.map((name) => this.recurring.stop(name)));
      this.logger.log('MAINTENANCE_SWEEP_INTERVAL_MINUTES=0 — retention sweeps are not scheduled');
      return;
    }

    const everyMs = minutes * 60_000;
    for (const name of MAINTENANCE_JOBS) {
      await this.recurring.every(name, everyMs);
    }
  }

  /**
   * Refresh tokens first, sessions second, and the order is forced rather
   * than chosen: `refresh_tokens.session_id` is `ON DELETE RESTRICT`, so a
   * session whose tokens are still there cannot go. A family therefore
   * disappears over two runs when its tokens fill a whole batch, which is the
   * correct behaviour for a bounded sweep.
   *
   * **Runs the admin session sweep in the same job (#276).**
   * `admin_sessions`/`admin_refresh_tokens` (ADR-0043 § 4) never had a sweep
   * at all before this — not "the wrong window", nothing. It shares
   * `AUTH_RETENTION_DAYS` rather than a knob of its own: an admin session and
   * a consumer session answer the same question ("is this credential still
   * usable, or evidence of one that was"), and `admin_sessions` carries no
   * `revoked_reason`, so there is no admin analogue of
   * `AUTH_INCIDENT_RETENTION_DAYS` to hold anything to. Logged separately from
   * the consumer counts, the same way the order-photo sweep logs message
   * photos separately in its own job — two tables, two counts, one schedule.
   */
  private async sweepAuthTokens(): Promise<void> {
    const { authRetentionDays, authIncidentRetentionDays } = this.config.maintenance;
    const now = Date.now();
    const cutoff = new Date(now - authRetentionDays * 86_400_000);
    // A family revoked for `reuse_detected` is held to its own, longer window:
    // it is the record that a theft signal fired. Bounded rather than kept
    // forever — a year, per ADR-0027; see `sessions.repository.ts`.
    const incidentCutoff = new Date(now - authIncidentRetentionDays * 86_400_000);

    const tokens = await this.inBatches((limit) =>
      this.sessions.deleteExpiredRefreshTokens({ cutoff, incidentCutoff, limit }),
    );
    const retired = await this.inBatches((limit) =>
      this.sessions.deleteRetiredSessions({ cutoff, incidentCutoff, limit }),
    );

    if (tokens > 0 || retired > 0) {
      this.logger.log(
        `Auth retention: deleted ${String(tokens)} refresh tokens and ${String(retired)} sessions`,
      );
    }

    await this.sweepAdminSessions(cutoff);
  }

  /**
   * Admin's half of {@link sweepAuthTokens} (#276) — see that method's doc for
   * why it shares `AUTH_RETENTION_DAYS` and has no incident window.
   *
   * Tokens first, sessions second, for the same reason as the consumer sweep:
   * `admin_refresh_tokens.session_id` is `ON DELETE RESTRICT`.
   */
  private async sweepAdminSessions(cutoff: Date): Promise<void> {
    const tokens = await this.inBatches((limit) =>
      this.admins.deleteExpiredRefreshTokens(cutoff, limit),
    );
    const retired = await this.inBatches((limit) =>
      this.admins.deleteRetiredSessions(cutoff, limit),
    );

    if (tokens > 0 || retired > 0) {
      this.logger.log(
        `Admin session retention: deleted ${String(tokens)} refresh tokens and ${String(retired)} sessions`,
      );
    }
  }

  /**
   * A challenge whose `expires_at` is older than `OTP_RETENTION_HOURS` (#276).
   *
   * `otp_challenges` holds a phone number on every row and had no sweep at
   * all until this one — `otp_challenges_expires_at_idx`'s own comment named
   * the job it now serves. The cutoff is `expires_at` alone: see
   * `OtpRepository.deleteExpired` for why that is what makes "never delete a
   * live challenge" true by construction.
   */
  private async sweepOtpChallenges(): Promise<void> {
    const { otpRetentionHours } = this.config.maintenance;
    const cutoff = new Date(Date.now() - otpRetentionHours * 3_600_000);

    const deleted = await this.inBatches((limit) =>
      this.otpChallenges.deleteExpired(cutoff, limit),
    );
    if (deleted > 0) {
      this.logger.log(`OTP challenges: deleted ${String(deleted)} expired rows`);
    }
  }

  /**
   * The rows' own `expires_at` is the cutoff — set from
   * `GEOCODE_CACHE_TTL_DAYS` when each row was written, and capped at thirty
   * days by Google's Maps Service Specific Terms 6.3.1 (ADR-0022). Expiring
   * on read already means nothing stale is ever served; this is what makes
   * the coordinates actually *deleted* rather than merely ignored, which is
   * what the terms say.
   */
  private async sweepGeocodeCache(): Promise<void> {
    const deleted = await this.inBatches((limit) => this.geocodeCache.deleteExpired(limit));
    if (deleted > 0) {
      this.logger.log(`Geocode cache: deleted ${String(deleted)} expired rows`);
    }
  }

  /**
   * A photo that reached `confirmed` and was never attached to an order, long
   * enough ago that the order it was meant for is not coming (#92).
   *
   * Row and object go together, inside one transaction per photo
   * (`OrderPhotosRepository.deleteAbandoned`), so a storage failure leaves the
   * row for the next run instead of orphaning the bytes. An attached photo is
   * untouched at any age — the conditional delete is guarded on
   * `status = 'confirmed'` and a null `order_id`, so a customer who attaches
   * one between the listing and the delete keeps it.
   */
  private async sweepAbandonedPhotos(): Promise<void> {
    const { batchSize, orderPhotoAbandonedAfterHours } = this.config.maintenance;
    const cutoff = new Date(Date.now() - orderPhotoAbandonedAfterHours * 3_600_000);

    let swept = 0;
    let raced = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const candidates = await this.photos.listAbandoned(cutoff, batchSize);
      if (candidates.length === 0) {
        break;
      }

      for (const candidate of candidates) {
        const deleted = await this.photos.deleteAbandoned(candidate.id, (key) =>
          this.storage.delete(key),
        );
        if (deleted) {
          swept += 1;
        } else {
          raced += 1;
        }
      }

      if (candidates.length < batchSize) {
        break;
      }
    }

    if (swept > 0 || raced > 0) {
      // No photo id is logged: an abandoned photo belongs to a customer, and
      // `docs/engineering/security.md` keeps identifiers out of logs nothing
      // needs them in. A count is what an operator reads.
      this.logger.log(
        `Order photos: swept ${String(swept)} abandoned photos (${String(raced)} were attached in the meantime)`,
      );
    }

    await this.sweepUnsentMessagePhotos(cutoff);
  }

  /**
   * A photo presigned into a conversation and never sent on a message —
   * whether its bytes never arrived, or arrived and the message was never
   * written (#181).
   *
   * **Part of the order-photo job, not a sixth scheduled job**, which is what
   * issue #181 asks for and what ADR-0033 § 4 means by "swept the same way
   * `order_photos` are": the same kind of object, in the same bucket, left
   * behind by the same kind of abandoned upload, on the same window
   * (`ORDER_PHOTO_ABANDONED_AFTER_HOURS`). A second scheduler would be a second
   * Redis key to keep, stop and rename for no difference in behaviour. It runs
   * after the order photos, so a storage outage that fails the first half
   * fails the job before this half starts, and the retry does both.
   *
   * **Both unsent states, unlike order photos.** An order photo's
   * `awaiting_upload` row is cleared by the customer's next presign; a message
   * photo's is cleared by that side's next presign *in that conversation* —
   * and a finished order's conversation never gets another one. Row and object
   * go together per photo (`MessageAttachmentsRepository.deleteUnsent`); a
   * photo that went out on a message is untouched at any age, which both the
   * conditional delete and the write-once trigger on the table guarantee.
   */
  private async sweepUnsentMessagePhotos(cutoff: Date): Promise<void> {
    const { batchSize } = this.config.maintenance;

    let swept = 0;
    let raced = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const candidates = await this.messagePhotos.listUnsent(cutoff, batchSize);
      if (candidates.length === 0) {
        break;
      }

      for (const candidate of candidates) {
        const deleted = await this.messagePhotos.deleteUnsent(candidate.id, (key) =>
          this.storage.delete(key),
        );
        if (deleted) {
          swept += 1;
        } else {
          raced += 1;
        }
      }

      if (candidates.length < batchSize) {
        break;
      }
    }

    if (swept > 0 || raced > 0) {
      // Counts only: a photo from a private conversation between two people
      // is the last thing whose identifier belongs in a log line.
      this.logger.log(
        `Message photos: swept ${String(swept)} unsent photos (${String(raced)} were sent in the meantime)`,
      );
    }
  }

  /**
   * A verification document whose upload URL was minted and never confirmed,
   * for a master who has since stopped (#128).
   *
   * **Worse than the order photo it mirrors, because of what it is.** An
   * abandoned order photo is a picture of a leaking tap; an abandoned
   * verification document is an identity document (ADR-0023) sitting in a
   * bucket for an application nobody will ever review. `master_documents`
   * already clears a stale presign when the same master presigns that type
   * again — which cleans up after everyone except the master who walked away,
   * and that master is the whole population this sweep is about.
   *
   * **Only `awaiting_upload`, at any age.** A document that reached review —
   * `pending_review` waiting for an admin, or `accepted`/`rejected` behind a
   * decision — is evidence, and `docs/product/admin-flow.md`'s "no
   * destructive deletes" is about exactly that. The repository names the
   * status rather than inferring it from a null column.
   *
   * **The window runs from the master's last document activity**, not from
   * each row's own age: a master part-way through gathering three documents
   * must not lose the first one while they are still working on the third.
   * See `MasterVerificationRepository.listAbandonedUploads`.
   */
  private async sweepAbandonedDocuments(): Promise<void> {
    const { batchSize, masterDocumentAbandonedAfterHours } = this.config.maintenance;
    const cutoff = new Date(Date.now() - masterDocumentAbandonedAfterHours * 3_600_000);

    let swept = 0;
    let raced = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const candidates = await this.documents.listAbandonedUploads(cutoff, batchSize);
      if (candidates.length === 0) {
        break;
      }

      for (const candidate of candidates) {
        const deleted = await this.documents.deleteAbandonedUpload(candidate.id, (key) =>
          this.storage.delete(key),
        );
        if (deleted) {
          swept += 1;
        } else {
          raced += 1;
        }
      }

      if (candidates.length < batchSize) {
        break;
      }
    }

    if (swept > 0 || raced > 0) {
      // Counts only. A document id names an identity document and a master id
      // names a person, and `docs/engineering/security.md` keeps both out of
      // a file more people read than expect to.
      this.logger.log(
        `Master documents: swept ${String(swept)} abandoned uploads (${String(raced)} were confirmed in the meantime)`,
      );
    }
  }

  /**
   * Position rows past `MASTER_LOCATION_TRAIL_MINUTES`, for the master who
   * stopped reporting and never came back (#105).
   *
   * **A floor, not a replacement.** `MasterLocationRepository.record` still
   * prunes the reporting master's own trail inside the transaction that
   * appends to it, and that stays: losing the per-write bound would make an
   * actively reporting master's history depend on how recently this ran. What
   * this adds is the only thing the write path cannot — an *elapsed-time*
   * bound on a master who is gone, for whom no write is ever coming.
   *
   * The cutoff is recomputed inside each batch's transaction, which is also
   * what re-publishes the narrow `SET LOCAL` escape hatch the append-only
   * trigger demands. So this is idempotent for the same reason every other
   * sweep here is: a second run measures against a later `now()` and finds
   * whatever has since expired, and nothing else.
   *
   * **A count, and nothing else, ever.** A per-master breakdown of how many
   * rows were retired is a statement about where people were and when — the
   * table this sweeps is the one `docs/engineering/security.md` singles out —
   * so not even a master id reaches a log line here, at any level.
   */
  private async sweepExpiredLocationTrails(): Promise<void> {
    const deleted = await this.inBatches((limit) => this.locations.sweepExpiredTrails(limit));
    if (deleted > 0) {
      this.logger.log(`Master locations: deleted ${String(deleted)} expired trail rows`);
    }
  }

  /**
   * Runs `deleteBatch` until it comes back short — the table is clean — or
   * until {@link MAX_BATCHES_PER_RUN}, whichever is first. Returns the total.
   *
   * The short-batch test is what makes a sweep with nothing to do cheap: one
   * indexed range scan that matches no rows, and it stops (#69's "a sweep
   * with nothing to delete is cheap and quiet").
   */
  private async inBatches(deleteBatch: (limit: number) => Promise<number>): Promise<number> {
    const { batchSize } = this.config.maintenance;
    let total = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const deleted = await deleteBatch(batchSize);
      total += deleted;
      if (deleted < batchSize) {
        break;
      }
    }

    return total;
  }
}
