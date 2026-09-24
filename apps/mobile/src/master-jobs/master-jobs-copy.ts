import type { OfferDistanceBand, OrderStatus } from '@tezusta/types';

/**
 * Every master-facing string on the offer feed and the job screen
 * (issue #199), in one file.
 *
 * **Proposed, not settled** — the same standing `orders-copy.ts` has. The
 * design system fixes colour, type and components, not words, and CLAUDE.md
 * §17 keeps the content of an empty or error state with the owner. Every string
 * here is listed in the pull request as placeholder copy for the owner to
 * accept or replace. Azerbaijani, matching the rest of the app.
 */
export const MASTER_JOBS_COPY = {
  feed: {
    title: 'Yeni sifarişlər',
    emptyTitle: 'Hələ sifariş yoxdur',
    emptyDescription: 'Yaxınlıqda sifariş olan kimi burada görünəcək.',
    offlineTitle: 'Sifariş almaq üçün onlayn olun',
    loadFailed: 'Sifarişlər yüklənmədi',
    retry: 'Yenidən cəhd et',
    accept: 'Qəbul et',
    decline: 'İmtina',
    /** "Qalıb: 2 dəq" — how long this offer stays open. */
    expiresIn: (minutes: number): string => `Qalıb: ${String(minutes)} dəq`,
    expiringNow: 'Vaxtı bitir',
    priceOnSite: 'Qiymət yerində',
    distance: {
      under_1km: '1 km-dən az',
      from_1_to_2km: '1–2 km',
      from_2_to_3km: '2–3 km',
      from_3_to_5km: '3–5 km',
      from_5_to_10km: '5–10 km',
      over_10km: '10 km-dən çox',
    } satisfies Record<OfferDistanceBand, string>,
    /** Accept's refusals, each a sentence the master can act on. */
    taken: 'Bu sifarişi artıq başqa usta götürüb.',
    expired: 'Bu təklifin vaxtı bitib.',
    alreadyWorking: 'Artıq bir sifarişdəsiniz. Əvvəlcə onu bitirin.',
    notEligible:
      'Hazırda bu sifarişi götürə bilməzsiniz. Onlayn və yaxınlıqda olduğunuzu yoxlayın.',
    failed: 'Alınmadı. Yenidən cəhd edin.',
  },

  current: {
    title: 'Cari sifariş',
    open: 'Aç',
  },

  job: {
    title: 'Sifariş',
    back: 'Geri',
    address: 'Ünvan',
    problem: 'Problem',
    price: 'Qiymət',
    priceOnSite: 'Qiyməti yerində təyin edirsiniz',
    openInMaps: 'Xəritədə aç',
    loadFailed: 'Sifariş yüklənmədi',
    retry: 'Yenidən cəhd et',
    /** Shown when the job read answers `null` — it ended, or it was taken back. */
    goneTitle: 'Bu sifariş artıq sizdə deyil',
    goneDescription: 'Müştəri ləğv edib və ya sifariş bitib.',
    toHome: 'Ana səhifəyə',
    /** Shown when the job read answers `null` because this master completed the job (#227). */
    completedTitle: 'İş tamamlandı',
    completedDescription: 'Təşəkkürlər! Yeni sifarişlər ana səhifədə görünəcək.',
    transitionFailed: 'Status dəyişmədi. Sifarişin son vəziyyəti göstərilir.',
    /** The button that moves the job to each status. */
    advance: {
      MASTER_ON_THE_WAY: 'Yola çıxdım',
      MASTER_ARRIVED: 'Çatdım',
      IN_PROGRESS: 'İşə başladım',
      COMPLETED: 'İşi bitirdim',
    } satisfies Partial<Record<OrderStatus, string>>,
    /** Where the job is, from the master's side. */
    status: {
      ACCEPTED: 'Qəbul etdiniz',
      MASTER_ON_THE_WAY: 'Yoldasınız',
      MASTER_ARRIVED: 'Ünvandasınız',
      IN_PROGRESS: 'İş gedir',
    } satisfies Partial<Record<OrderStatus, string>>,
    handBack: 'Gələ bilmirəm',
    handBackTitle: 'Sifarişi geri qaytarırsınız',
    handBackDescription:
      'Sifariş başqa ustalara göndəriləcək. Səbəbi qısa yazın — müştəri üçün vacibdir.',
    handBackReason: 'Səbəb',
    handBackConfirm: 'Geri qaytar',
    handBackCancel: 'Ləğv et',
    handBackReasonRequired: 'Səbəbi yazın.',
  },

  reporting: {
    staleDescription:
      'Tətbiq bir neçə dəqiqədir məkan göndərmir. Telefon batareya qənaəti tətbiqi dayandırmış ola bilər — tətbiqi açıq saxlayın.',
    backgroundDenied:
      'Arxa planda məkan icazəsi yoxdur. Tətbiq bağlı olanda müştəri sizi xəritədə görməyəcək.',
  },
} as const;
