import type {
  AdminSubscriptionPriceState,
  SubscriptionBillingPeriod,
  SubscriptionStatus,
} from '@tezusta/types';

/** English placeholder copy for the subscription screens (#324). */
export const subscriptionCopy = {
  intro:
    'The one master subscription: what a month and a year cost, how long the trial and grace last, and whether masters can buy it.',
  loading: 'Loading…',
  loadFailed: 'The subscription could not be loaded.',
  retry: 'Try again',
  cancel: 'Cancel',
  saving: 'Saving…',

  prices: 'Prices',
  period: { monthly: 'Monthly', yearly: 'Yearly' } satisfies Record<
    SubscriptionBillingPeriod,
    string
  >,
  noPrice: 'No price yet',
  scheduledFrom: (price: string, date: string) => `${price} from ${date}`,
  withdraw: 'Withdraw',
  changePrices: 'Change prices',

  settings: 'Settings',
  trialDays: 'Trial',
  graceDays: 'Grace',
  days: (days: number) => (days === 1 ? '1 day' : `${String(days)} days`),
  purchasesOpen: 'Purchases',
  open: 'Open',
  closed: 'Closed',
  changeSettings: 'Change settings',

  history: 'Price history',
  historyCaption: 'Every price version ever entered, newest first',
  historyColumns: {
    period: 'Period',
    price: 'Price',
    effectiveFrom: 'Takes effect',
    entered: 'Entered',
    state: 'State',
  },
  noHistory: 'No price has been entered yet.',
  priceState: {
    current: 'Current',
    scheduled: 'Scheduled',
    superseded: 'Replaced',
    withdrawn: 'Withdrawn',
    withdrawal: 'Withdrawal',
  } satisfies Record<AdminSubscriptionPriceState, string>,
  none: '—',

  pricesDialog: {
    title: 'Change prices',
    body: 'Each changed price becomes a new version. Prices already paid keep the price they were paid at.',
    monthly: 'Monthly price (AZN)',
    yearly: 'Yearly price (AZN)',
    unchangedHint: 'Leave empty to keep it as it is.',
    effectiveFrom: 'Takes effect',
    effectiveFromHint: (days: number) =>
      `Leave empty for the earliest allowed. A period masters have paid for needs ${String(days)} days' notice.`,
    confirmLarge: 'I have checked this amount: it is a large change.',
    nothingChanged: 'Enter at least one price.',
    badAmount: 'Enter an amount like 20 or 19.90.',
    submit: 'Save prices',
  },
  settingsDialog: {
    title: 'Change settings',
    body: 'A trial change applies to trials started from now on; a grace change, to lapses from now on.',
    trialDays: 'Trial (days, 0–90)',
    graceDays: 'Grace (days, 0–30)',
    purchasesOpen: 'Purchases are open',
    badTrial: 'Enter a whole number from 0 to 90.',
    badGrace: 'Enter a whole number from 0 to 30.',
    submit: 'Save settings',
  },
  withdrawDialog: {
    title: 'Withdraw the scheduled price?',
    body: (period: string, price: string, date: string) =>
      `The ${period.toLowerCase()} price of ${price} from ${date} will not take effect. The history keeps it.`,
    submit: 'Withdraw',
  },

  reasonLabel: 'Reason',
  reasonHint: 'Recorded in the audit log.',
  reasonEmpty: 'Write a reason.',
  reasonTooLong: 'Keep the reason under 600 characters.',

  errors: {
    SUBSCRIPTION_PRICE_ALREADY_SCHEDULED:
      'A price for this period is already scheduled. Withdraw it first.',
    SUBSCRIPTION_PRICE_NOTICE_REQUIRED:
      'Masters have paid for this period, so the new price needs the full notice. Pick a later date.',
    SUBSCRIPTION_PRICE_EFFECTIVE_FROM_INVALID:
      'The date must be from now and at most a year ahead.',
    SUBSCRIPTION_PRICE_CONFIRMATION_REQUIRED:
      'This is a large change. Check the amount, tick the confirmation and save again.',
    SUBSCRIPTION_PRICE_NOT_SCHEDULED: 'This price has already taken effect or been withdrawn.',
    SUBSCRIPTION_PURCHASES_NEED_PRICES:
      'Purchases cannot open until both the monthly and the yearly price are in effect.',
    SUBSCRIPTION_TRANSITION_NOT_ALLOWED:
      'This subscription cannot be cancelled in its current state.',
    VALIDATION_FAILED: 'Some values were not accepted. Check them and try again.',
    FORBIDDEN: 'Your role does not allow this change.',
    NOT_FOUND: 'This master no longer exists.',
    unexpected: 'Something went wrong. Try again.',
  },

  master: {
    title: 'Subscription',
    none: 'No subscription yet. A trial starts when verification approves the master.',
    loadFailed: 'The subscription could not be loaded.',
    status: 'Status',
    billingPeriod: 'Billing period',
    granted: 'Granted days',
    periodEnd: 'Period ends',
    graceEnd: 'Grace ends',
    queued: 'Next period',
    entitled: 'Receives offers',
    yes: 'Yes',
    no: 'No',
    history: 'Subscription history',
    noEvents: 'No events yet.',
    grant: 'Grant days',
    cancel: 'Cancel subscription',
    event: {
      trial_started: 'Trial started',
      period_activated: 'Period paid',
      period_queued: 'Period paid in advance',
      period_granted: 'Days granted',
      queued_period_started: 'Paid period started',
      cancelled: 'Cancelled',
      grace_entered: 'Entered grace',
      expired: 'Expired',
    } as Readonly<Record<string, string>>,
    paidAt: (amount: string) => `paid ${amount}`,
    by: (actor: string) => `by ${actor}`,
    actor: (raw: string) =>
      raw === 'system' ? 'the system' : raw === 'provider' ? 'the payment provider' : 'an admin',
    grantDialog: {
      title: 'Grant days',
      body: (name: string) =>
        `${name} gets the days on top of a running period, or from now if nothing is running.`,
      days: 'Days (1–366)',
      badDays: 'Enter a whole number from 1 to 366.',
      submit: 'Grant',
    },
    cancelDialog: {
      title: 'Cancel this subscription?',
      body: (name: string) =>
        `${name}'s current period runs to its end and does not renew. A period already paid in advance still starts.`,
      submit: 'Cancel subscription',
    },
    done: { grant: 'The days were granted.', cancel: 'The subscription was cancelled.' },
  },

  status: {
    trialing: 'Trial',
    active: 'Active',
    past_due: 'In grace',
    cancelled: 'Cancelled',
    expired: 'Expired',
  } satisfies Record<SubscriptionStatus, string>,
  noSubscription: 'None',
};
