import type { MasterSubscription } from '@tezusta/types';

/**
 * What the subscription looked like when the master left for the provider's
 * page, so the return page can tell a confirmed payment from an unchanged
 * subscription (ADR-0061 § 6).
 *
 * The return itself proves nothing — only the provider's webhook extends a
 * period (ADR-0057) — so this is never treated as evidence of payment. It is
 * only the "before" the return page compares the server's answer against.
 * `sessionStorage`, so it lives in this tab and dies with it.
 */
export type SubscriptionSnapshot = Pick<
  MasterSubscription,
  'status' | 'currentPeriodEnd' | 'nextBillingPeriod'
>;

const KEY = 'tezusta.web.checkout';

export function saveSnapshot(subscription: MasterSubscription): void {
  const snapshot: SubscriptionSnapshot = {
    status: subscription.status,
    currentPeriodEnd: subscription.currentPeriodEnd,
    nextBillingPeriod: subscription.nextBillingPeriod,
  };
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    // Storage refused (private mode, quota): the return page then cannot
    // confirm, and says the payment will appear once it is confirmed.
  }
}

export function readSnapshot(): SubscriptionSnapshot | undefined {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw === null) return undefined;
    const value = JSON.parse(raw) as Partial<SubscriptionSnapshot>;
    if (typeof value.status !== 'string' || typeof value.currentPeriodEnd !== 'string') {
      return undefined;
    }
    return {
      status: value.status,
      currentPeriodEnd: value.currentPeriodEnd,
      nextBillingPeriod: value.nextBillingPeriod ?? null,
    };
  } catch {
    return undefined;
  }
}

export function clearSnapshot(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/** A paid period moves the end forward, queues the next one, or changes the status. */
export function hasChanged(before: SubscriptionSnapshot, now: MasterSubscription): boolean {
  return (
    now.currentPeriodEnd !== before.currentPeriodEnd ||
    now.nextBillingPeriod !== before.nextBillingPeriod ||
    now.status !== before.status
  );
}

/**
 * Leaves for the provider's hosted page. Only an `https:` address: the URL
 * comes from the API, and a `javascript:` one must never run here even if a
 * provider adapter got it wrong.
 */
export function goToCheckout(checkoutUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(checkoutUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  browser.assign(url.href);
  return true;
}

/** The one navigation away from the page, behind a seam a test can replace. */
export const browser = {
  assign(url: string): void {
    window.location.assign(url);
  },
};
