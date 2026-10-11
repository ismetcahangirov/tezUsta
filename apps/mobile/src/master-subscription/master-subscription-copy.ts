import type { SubscriptionBillingPeriod } from '@tezusta/types';

/**
 * PLACEHOLDER COPY — the owner's to approve (#325, CLAUDE.md §17).
 *
 * No price, no link and no call to buy anywhere in it: the subscription is
 * sold outside the app (ADR-0046 § 7). It says where the subscription stands,
 * what that means for receiving work, and that renewing happens elsewhere.
 */
export const MASTER_SUBSCRIPTION_COPY = {
  title: 'Abunə',
  back: 'Geri',
  open: 'Abunəyə bax',
  loadFailed: 'Abunə məlumatı yüklənmədi.',
  retry: 'Yenidən cəhd et',

  status: {
    none: 'Abunə yoxdur',
    trialing: 'Sınaq',
    active: 'Aktiv',
    past_due: 'Güzəştdə',
    cancelled: 'Ləğv edilib',
    expired: 'Bitib',
  },

  period: {
    monthly: 'Aylıq',
    yearly: 'İllik',
  } satisfies Record<SubscriptionBillingPeriod, string>,

  /** One line under the status on the home card. */
  line: {
    none: 'Yoxlamadan keçəndə sınaq müddəti başlayır.',
    runsUntil: (date: string) => `${date} tarixinədək`,
    cancelledUntil: (date: string) => `${date} tarixinədək işləyir, yenilənməyəcək`,
    graceUntil: (date: string) => `${date} tarixinədək sifariş alırsınız`,
    expired: 'Yeni sifarişlər sizə göndərilmir.',
  },

  /** The queued period, when one is paid for in advance. */
  next: (period: string, date: string) => `Növbəti: ${period.toLowerCase()}, ${date} tarixindən`,

  warning: {
    ending: (date: string) => `Abunəniz ${date} tarixində bitir.`,
    grace: (date: string) =>
      `Abunənizin müddəti bitib. ${date} tarixinədək sifariş almağa davam edirsiniz.`,
    expired: 'Abunəniz bitib. Yeni sifarişlər sizə göndərilmir.',
  },

  details: {
    status: 'Vəziyyət',
    period: 'Dövr',
    trialPeriod: 'Sınaq müddəti',
    grantedPeriod: 'Verilmiş günlər',
    periodEnd: 'Dövrün sonu',
    graceEnd: 'Güzəştin sonu',
    nextPeriod: 'Növbəti dövr',
    receivesWork: 'Sifariş alırsınız',
    yes: 'Bəli',
    no: 'Xeyr',
    none: 'Yoxlamadan keçdikdən sonra sınaq müddətiniz başlayacaq və burada görünəcək.',
    /** Where renewing happens — neutral, with no link (ADR-0046 § 7). */
    howToRenew:
      'Abunə tətbiqdən kənarda alınır və yenilənir. Sualınız olarsa, TezUsta dəstəyi ilə əlaqə saxlayın.',
    queuedExplanation: 'Əvvəlcədən ödənilmiş dövr cari dövr bitəndə başlayır.',
  },

  /** On the availability card, when going online was refused for the subscription. */
  availabilityRefused: 'Abunəniz bitdiyi üçün onlayn ola bilmirsiniz.',
} as const;
