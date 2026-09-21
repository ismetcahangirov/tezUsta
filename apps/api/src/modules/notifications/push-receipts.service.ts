import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { PUSH_RECEIPT_SOURCE } from '../../infra/push/push-sender.types';
import type { PushReceiptOutcome, PushReceiptSource } from '../../infra/push/push-sender.types';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import { RecurringWorkService } from '../../infra/queue/recurring-work.service';
import { DevicesService } from '../devices/devices.service';
import { PushTicketsRepository } from './push-tickets.repository';
import type { DueTicket } from './push-tickets.repository';

/**
 * The recurring job's name, which is also its scheduler's id.
 *
 * Written into Redis and surviving a deploy, exactly like the names in
 * `maintenance.constants.ts`: renaming it leaves the old scheduler producing
 * jobs nothing is registered to handle. Rename by stopping the old id in the
 * same release that introduces the new one.
 */
export const PUSH_RECEIPT_SWEEP_JOB = 'maintenance-push-receipts';

/** What one run did, for the log line and for the tests. */
export interface ReceiptSweepResult {
  readonly examined: number;
  readonly resolved: number;
  readonly retired: number;
  readonly expired: number;
}

/**
 * Asks Expo what became of the pushes it accepted, and retires the devices it
 * reports as gone (issue #142).
 *
 * ## Why this is the only place a dead token becomes visible
 *
 * Expo's push API is two-phase by design. `/send` answers with a **ticket**
 * meaning "accepted"; the delivery outcome only exists later, at the receipts
 * endpoint. A token belonging to an uninstalled app passes phase one cleanly
 * and fails phase two — so without this sweep the queue happily re-sends to it
 * forever: every send "succeeds", nothing errors, and the only symptom is a
 * delivery rate nobody is measuring. That silence is also the argument for the
 * alarm on the credentials branch below.
 *
 * ## Why it runs on `maintenance` and not on `notifications`
 *
 * `queue.constants.ts` draws the line by **cause** rather than by subject, and
 * `maintenance` is "work that is due because time passed". Receipt polling is
 * a clock. Putting it on `notifications` would put it in the same concurrency
 * budget as an offer push a master is waiting for, which is the contention the
 * two queues exist to keep apart. `DispatchReconciler` is the precedent: it is
 * dispatch's code running on `maintenance` for exactly this reason, and
 * `backend-architecture.md` § Background jobs records it.
 *
 * ## Idempotency is the whole design
 *
 * The sweep re-reads tickets it has already resolved after a retry or a
 * redeploy, so every action it takes has to be a no-op the second time.
 * Retiring an already-retired device writes nothing — `revokeUnreachable` is
 * conditional on `revoked_at IS NULL` — and deleting an already-deleted row
 * affects none. Nothing here counts anything that a re-run would double.
 *
 * ## What it does about a failed request
 *
 * Nothing, deliberately: the error escapes and BullMQ retries the job with its
 * configured backoff. That matters more than it looks, because the vendor
 * client **does not retry this endpoint**. `sendPushNotificationsAsync` wraps
 * its call in `promise-retry` and a concurrency limiter; the receipts call in
 * `expo-server-sdk@7.2.0` goes straight to `requestAsync` with neither. The
 * queue's backoff is therefore the only backoff a 429 here will ever get, and
 * leaving the rows in place is what makes coming back later free.
 */
@Injectable()
export class PushReceiptsService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(PushReceiptsService.name);

  constructor(
    private readonly handlers: DeferredJobHandlerRegistry,
    private readonly recurring: RecurringWorkService,
    private readonly tickets: PushTicketsRepository,
    private readonly devices: DevicesService,
    @Inject(PUSH_RECEIPT_SOURCE) private readonly receipts: PushReceiptSource,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Registered in `onModuleInit` rather than at bootstrap, so the handler
   * exists before any worker starts fetching. The registry throws on a
   * duplicate name, which turns "two modules both think they own this job"
   * into a boot failure instead of import-order-dependent behaviour.
   */
  onModuleInit(): void {
    this.handlers.register(PUSH_RECEIPT_SWEEP_JOB, async () => {
      await this.sweep();
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const seconds = this.config.notifications.receiptSweepIntervalSeconds;

    if (seconds === 0) {
      // Zero has to mean "make sure there is nothing registered", not merely
      // "do not register": a scheduler left behind by an earlier release keeps
      // producing jobs after the flag is turned off. `stop` on a scheduler
      // that was never created is a no-op.
      await this.recurring.stop(PUSH_RECEIPT_SWEEP_JOB);
      this.logger.log(
        'PUSH_RECEIPT_SWEEP_INTERVAL_SECONDS=0 — push receipts are not checked and dead tokens are never retired',
      );
      return;
    }

    await this.recurring.every(PUSH_RECEIPT_SWEEP_JOB, seconds * 1000);
  }

  /**
   * One run.
   *
   * **The expiry sweep comes first**, so the batch below is never spent on
   * rows Expo has already forgotten. Without that ordering, a backlog older
   * than the retention window would fill every run's budget with questions
   * that can only be answered "no receipt", and the fresh tickets behind it
   * would never be reached.
   */
  async sweep(): Promise<ReceiptSweepResult> {
    const now = Date.now();
    const { receiptRetentionHours, receiptMinAgeSeconds, receiptMaxPerRun } =
      this.config.notifications;

    const expired = await this.tickets.deleteOlderThan(
      new Date(now - receiptRetentionHours * 60 * 60 * 1000),
    );

    const due = await this.tickets.findDue(
      new Date(now - receiptMinAgeSeconds * 1000),
      receiptMaxPerRun,
    );

    if (due.length === 0) {
      return this.report({ examined: 0, resolved: 0, retired: 0, expired });
    }

    // A whole-request failure escapes from here, which is how the job asks
    // BullMQ for a retry — and leaves every row in place to be asked about
    // again, which costs nothing.
    const answers = await this.receipts.fetchReceipts(due.map((ticket) => ticket.receiptId));

    const settled: string[] = [];
    let retired = 0;

    for (const ticket of due) {
      const outcome = answers.get(ticket.receiptId);
      if (outcome === undefined) {
        // Not ready yet. Expo omits a receipt it has not produced, and this
        // is the one answer that must not be read as a verdict: the row stays
        // on the worklist until it is answered or until it expires.
        continue;
      }

      settled.push(ticket.id);
      if (await this.act(ticket, outcome)) {
        retired += 1;
      }
    }

    await this.tickets.deleteByIds(settled);

    return this.report({ examined: due.length, resolved: settled.length, retired, expired });
  }

  /**
   * What one resolved receipt is worth doing about. Returns whether this call
   * was the one that retired a device.
   *
   * **Every branch is distinct and only one of them touches a device.** That
   * asymmetry is the issue's requirement and the reason the port answers six
   * outcomes rather than collapsing them: a credentials fault is not a dead
   * phone, an oversized payload is not a dead phone, and a code nobody has
   * read is certainly not a dead phone.
   */
  private async act(ticket: DueTicket, outcome: PushReceiptOutcome): Promise<boolean> {
    switch (outcome.status) {
      case 'delivered':
        return false;

      case 'unreachable':
        // Idempotent: the update is conditional on the device still being
        // live, so a sweep re-run over the same ticket writes nothing and the
        // original `revoked_at` — and the original reason — survive.
        return this.devices.retireUnreachable(ticket.deviceId);

      case 'credentials':
        /**
         * **An operator alarm, and not the device's fault.** Every push this
         * project sends is failing while this is true, and no amount of
         * retrying or token-pruning changes it — somebody has to fix the FCM
         * or APNs credentials. Logged at `error` because that is the level an
         * alert is wired to, and because the alternative is the silent total
         * outage this whole sweep exists to make visible.
         */
        this.logger.error(
          `Push credentials are being refused by the provider (${outcome.code}): ${outcome.message}. ` +
            'No device is at fault and no retry will help — check the project push credentials.',
        );
        return false;

      case 'sender-error':
        // Ours to fix, and identical on every retry. No device id and no
        // token in the line: the code is what a developer needs.
        this.logger.error(
          `A push this service sent was refused (${outcome.code}): ${outcome.message}`,
        );
        return false;

      case 'transient':
        // The provider asked us to slow down. There is nothing to re-deliver
        // — the notification is already lost — so this is a record, not a
        // retry, and the device is left exactly as it was.
        this.logger.warn(`A push was refused transiently (${outcome.code}): ${outcome.message}`);
        return false;

      case 'unknown':
        /**
         * Logged and left alone. Retiring a device on a code nobody has read
         * is how a working install stops receiving anything with no error
         * anywhere to explain it — and three of the codes the shipped SDK
         * types have no published meaning at all.
         */
        this.logger.warn(
          `Unrecognised Expo push receipt error "${outcome.code}" — nothing was changed: ${outcome.message}`,
        );
        return false;
    }
  }

  /** Silent when there was nothing to do; a line when there was. */
  private report(result: ReceiptSweepResult): ReceiptSweepResult {
    if (result.examined === 0 && result.expired === 0) {
      // A line every interval saying nothing happened is a line nobody reads,
      // and the whole value of the one below is that it is rare.
      return result;
    }

    this.logger.log(
      `Push receipts: examined ${String(result.examined)}, resolved ${String(
        result.resolved,
      )}, retired ${String(result.retired)} device(s), dropped ${String(
        result.expired,
      )} past Expo's retention window`,
    );
    return result;
  }
}
