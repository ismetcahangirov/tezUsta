import { Injectable, Logger } from '@nestjs/common';
import type { SubscriptionBillingPeriod } from '@tezusta/types';

/** The pushes a subscription raises (#326), as `NotificationKind` names them. */
export type SubscriptionNoticeKindName =
  | 'subscription-ending'
  | 'subscription-grace'
  | 'subscription-expired'
  | 'subscription-renewed'
  | 'subscription-price-change';

/** One push to one master, raised once its ledger row has committed. */
export interface SubscriptionNotice {
  readonly masterId: string;
  readonly kind: SubscriptionNoticeKindName;
  readonly billingPeriod: SubscriptionBillingPeriod | null;
  /** The period or grace end the push is about. */
  readonly endsAt?: Date | undefined;
  /** When a changed price applies. */
  readonly effectiveFrom?: Date | undefined;
}

export type SubscriptionNotifier = (notice: SubscriptionNotice) => Promise<void>;

/**
 * The slot the notifications module fills at boot (#326), so this module can
 * raise a push without importing the module that sends it.
 *
 * The arrow has to point this way: `NotificationsModule` imports
 * `MastersModule` to resolve a master into an account, and `MastersModule`
 * imports this module, so an import from here to notifications would close a
 * cycle. `OrderNotificationsRegistry` is the same shape for orders.
 *
 * Raising is **after commit and best-effort**: the subscription moved, and a
 * push is its consequence. A notifier that throws is logged, never rethrown,
 * so a queue having a bad second cannot fail a payment confirmation or a
 * sweep.
 */
@Injectable()
export class SubscriptionNoticesRegistry {
  private readonly logger = new Logger(SubscriptionNoticesRegistry.name);
  private readonly notifiers = new Map<string, SubscriptionNotifier>();

  register(name: string, notifier: SubscriptionNotifier): void {
    if (this.notifiers.has(name)) {
      throw new Error(`A subscription notifier named ${name} is already registered`);
    }
    this.notifiers.set(name, notifier);
  }

  async raise(notices: readonly SubscriptionNotice[]): Promise<void> {
    for (const notice of notices) {
      for (const [name, notifier] of this.notifiers) {
        try {
          await notifier(notice);
        } catch (error) {
          this.logger.error(
            `Raising ${notice.kind} through ${name} failed; the subscription change stands: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }
}
