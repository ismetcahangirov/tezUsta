import type { SubscriptionBillingPeriod, SubscriptionStatus } from '@tezusta/types';

/**
 * Every string the page shows, in one place.
 *
 * **Placeholder copy, in Azerbaijani.** ADR-0061 leaves the page's wording to
 * the owner (CLAUDE.md § 17), and the languages at launch are still open. What
 * is not a placeholder is what the copy must never do: tell a visitor whether
 * an email address belongs to a master (ADR-0061 § 4).
 */
export const copy = {
  appName: 'TezUsta',
  pageTitle: 'Usta abunəliyi',
  loading: 'Yüklənir…',
  retry: 'Yenidən cəhd et',
  unexpected: 'Nəsə alınmadı. Yenidən cəhd edin.',
  rateLimited: 'Çox cəhd oldu. Bir neçə dəqiqə gözləyib yenidən cəhd edin.',

  signIn: {
    intro:
      'Bu səhifə TezUsta tətbiqində qeydiyyatdan keçmiş ustalar üçündür. ' +
      'Tətbiqdəki e-poçt ünvanınızla daxil olun.',
    email: 'E-poçt ünvanı',
    emailHint: 'Məsələn, usta@gmail.com',
    sendCode: 'Kod göndər',
    sending: 'Göndərilir…',
    // The same sentence for every address: whether a code was really sent is
    // exactly what the page must not reveal (ADR-0061 § 4).
    codeSent: 'Ünvan qeydiyyatlı ustaya aiddirsə, ona e-poçtla kod göndərildi.',
    code: 'Təsdiq kodu',
    verify: 'Daxil ol',
    verifying: 'Yoxlanılır…',
    changeEmail: 'Başqa ünvan',
    invalidEmail: 'Düzgün e-poçt ünvanı daxil edin.',
    wrongCode: 'Kod yanlışdır və ya vaxtı keçib.',
    unavailable: 'E-poçt göndərmək hazırda mümkün deyil. Bir az sonra yenidən cəhd edin.',
  },

  subscription: {
    signOut: 'Çıxış',
    statusTitle: 'Abunəliyiniz',
    status: {
      trialing: 'Sınaq müddəti',
      active: 'Aktiv',
      past_due: 'Ödəniş gecikir',
      cancelled: 'Yenilənməyəcək',
      expired: 'Bitib',
    } satisfies Record<SubscriptionStatus, string>,
    periodEnds: (date: string) => `Cari müddət ${date} tarixində bitir.`,
    graceEnds: (date: string) => `Güzəşt müddəti ${date} tarixində bitir.`,
    nextQueued: (period: SubscriptionBillingPeriod) =>
      `Növbəti ${period === 'monthly' ? 'aylıq' : 'illik'} müddət artıq ödənilib.`,
    notVerified: 'Profiliniz hələ təsdiqlənməyib. Təsdiqdən sonra pulsuz sınaq müddəti başlayır.',
    loadFailed: 'Abunəlik məlumatını yükləmək alınmadı.',

    renewalOn:
      'Avtomatik yenilənmə açıqdır: saxlanılmış kartdan hər müddətin sonunda ödəniş alınır.',
    renewalOff: 'Avtomatik yenilənmə bağlıdır.',
    turnOff: 'Avtomatik yenilənməni dayandır',
    turningOff: 'Dayandırılır…',
    turnOffNote: 'Ödənilmiş müddət sonuna qədər davam edir.',

    buyTitle: 'Abunəlik al',
    period: {
      monthly: 'Aylıq',
      yearly: 'İllik',
    } satisfies Record<SubscriptionBillingPeriod, string>,
    price: (amount: string, period: SubscriptionBillingPeriod) =>
      `${amount} / ${period === 'monthly' ? 'ay' : 'il'}`,
    autoRenewConsent: 'Kartımı yadda saxla və hər müddətin sonunda avtomatik ödə',
    pay: 'Ödənişə keç',
    paying: 'Yönləndirilir…',
    purchasesClosed: 'Abunəlik satışı hələ açılmayıb.',
    notEligible: 'Profiliniz təsdiqlənməyib və ya dayandırılıb, ona görə abunəlik ala bilməzsiniz.',
    alreadyQueued:
      'Növbəti müddət artıq ödənilib. Cari müddət bitəndən sonra yenidən ala bilərsiniz.',
  },

  return: {
    confirming: 'Ödəniş təsdiqlənir…',
    confirmed: 'Ödəniş təsdiqləndi. Abunəliyiniz yeniləndi.',
    pending: 'Ödəniş hələ təsdiqlənməyib. Ödəmisinizsə, təsdiqlənən kimi abunəliyinizdə görünəcək.',
    back: 'Abunəliyə qayıt',
  },
} as const;
