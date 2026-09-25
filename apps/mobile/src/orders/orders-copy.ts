/**
 * Every customer-facing string in the order-creation flow, in one file.
 *
 * **Proposed, not settled.** `docs/design/design-system.md` fixes colour,
 * type, spacing and the component inventory; it does not fix words, and
 * CLAUDE.md §17 keeps the content of an empty or error state with the owner.
 * These are a first draft written so the flow can be built and tested — every
 * one of them is listed in the pull request for the owner to accept or
 * replace, and none of them should be treated as final because it shipped.
 *
 * Azerbaijani, matching the rest of the app. Kept here rather than inline so
 * the eventual move to real localisation is a file move.
 */
export const ORDERS_COPY = {
  /** The step indicator: "Sifariş 2/4". Service selection is step 1, on the catalogue. */
  stepLabel: (current: number, total: number): string =>
    `Sifariş ${String(current)}/${String(total)}`,
  back: 'Geri',
  next: 'Davam et',
  cancel: 'İmtina et',

  describeTitle: 'Problemi təsvir edin',
  describeHint: 'Ustanın nə ilə qarşılaşacağını bilməsi işi tez həll etməyə kömək edir.',
  descriptionLabel: 'Nə baş verib?',
  descriptionPlaceholder: 'Məsələn: mətbəxdə kran sızır, su dayanmır.',
  descriptionTooShort: 'Bir az daha ətraflı yazın.',
  descriptionTooLong: 'Təsvir çox uzundur.',

  photosTitle: 'Şəkil əlavə edin',
  photosHint:
    'İstəyə bağlıdır. Şəkil usta üçün faydalıdır, amma olmadan da sifariş verə bilərsiniz.',
  addPhoto: 'Şəkil əlavə et',
  removePhoto: 'Şəkli sil',
  photoUploading: 'Şəkil yüklənir…',
  photoFailed: 'Şəkil yüklənmədi. Sifarişi şəkilsiz də göndərə bilərsiniz.',
  photoLimitReached: 'Daha şəkil əlavə etmək olmur.',
  photoPermissionDenied: 'Şəkillərə giriş icazəsi verilmədi.',

  addressTitle: 'Ünvanı seçin',
  addressHint: 'Usta bu ünvana gələcək.',
  addressEmptyTitle: 'Saxlanmış ünvan yoxdur',
  addressEmptyDescription: 'Sifariş vermək üçün əvvəlcə bir ünvan əlavə edin.',
  manageAddresses: 'Ünvanları idarə et',
  addressLoadFailed: 'Ünvanlar yüklənmədi.',
  retry: 'Yenidən cəhd et',

  confirmTitle: 'Sifarişi yoxlayın',
  confirmService: 'Xidmət',
  confirmAddress: 'Ünvan',
  confirmProblem: 'Problem',
  confirmPhotos: 'Şəkillər',
  submit: 'Sifarişi göndər',

  priceEstimateLabel: 'Təxmini qiymət',
  /** Deliberately the word "təxmini" everywhere — this is never a quotable price (ADR-0013). */
  priceEstimateNote: 'Bu təxmini aralıqdır. Dəqiq qiyməti sifarişi qəbul edən usta təyin edir.',
  priceInspection: 'Qiymət baxışdan sonra',
  priceInspectionNote: 'Usta işi yerində görüb qiyməti təyin edəcək.',
  priceUnknown: 'Hazırda bu xidmət üçün qiymət aralığı yoxdur.',

  submitFailed: 'Sifariş göndərilmədi. Yenidən cəhd edin.',
  offlineError: 'Bağlantı yoxdur. İnterneti yoxlayıb yenidən cəhd edin.',
  notFoundError: 'Seçilmiş xidmət və ya ünvan artıq mövcud deyil.',
  openOrderLimitError:
    'Açıq sifarişlərinizin sayı həddə çatıb. Onlardan biri bitəndə və ya ləğv olunanda yenisini göndərə bilərsiniz.',

  createdTitle: 'Sifariş göndərildi',
  createdDescription: 'Yaxınlıqdakı ustalar axtarılır.',
  done: 'Bağla',

  /**
   * The order screen (issue #85's landing place, issue #155's subject).
   *
   * **Two strings per status, and the second one is the point.** A label says
   * where the order is; the line under it says what happens next, which is the
   * half a person waiting at home actually wants
   * ([ADR-0029](../../../../docs/decisions/ADR-0029-customer-order-screen.md)).
   * Neither is final: like everything else in this file they are a first draft
   * for the owner to accept or replace.
   */
  detail: {
    title: 'Sifariş',
    back: 'Geri',

    service: 'Xidmət',
    address: 'Ünvan',
    problem: 'Problem',
    photos: 'Şəkillər',

    price: 'Qiymət',
    /** Shown while `priceMinor` is null — which is every order that has not been accepted. */
    priceNotSet: 'Qiyməti sifarişi qəbul edən usta təyin edir.',

    loading: 'Sifariş yüklənir',
    /** A refresh failed with the order already on screen. */
    staleNotice: 'Yenilənmədi. Göstərilən məlumat bir az köhnə ola bilər.',

    /**
     * The API answers 404 for an order that is not the caller's, never 403
     * (`orders.controller.ts`), so this one string covers "no such order" and
     * "not yours" alike — which is the whole reason the API does it that way.
     */
    notFoundTitle: 'Sifariş tapılmadı',
    notFoundDescription: 'Bu sifariş mövcud deyil və ya sizə aid deyil.',

    errorTitle: 'Sifariş açılmadı',
    errorDescription: 'Bağlantını yoxlayıb yenidən cəhd edin.',

    /** One photo's short-lived URL failed; the rest of the screen is fine. */
    photoFailed: 'Şəkil açılmadı',
    servicePending: '—',
    addressPending: '—',
  },

  /**
   * The order list — the way back to an order after the app has been closed
   * (issue #160,
   * [ADR-0030](../../../../docs/decisions/ADR-0030-customer-root-navigation-and-order-list.md)).
   *
   * As draft as everything else in this file, and the empty state doubly so:
   * CLAUDE.md §17 keeps the *content* of an empty state with the owner even
   * now that the components it is built from are settled.
   */
  list: {
    /** The tab's label. Short, because a tab bar has no room to explain. */
    tab: 'Sifarişlər',
    title: 'Sifarişlərim',

    /**
     * The two headings, shown only when both halves have rows — one heading
     * over a list with nothing to contrast it against is furniture.
     */
    openHeading: 'Davam edir',
    finishedHeading: 'Bitmiş sifarişlər',

    loading: 'Sifarişlər yüklənir',
    staleNotice: 'Yenilənmədi. Siyahı bir az köhnə ola bilər.',

    emptyTitle: 'Hələ sifarişiniz yoxdur',
    emptyDescription: 'İlk sifarişinizi vermək üçün xidmət seçin.',
    emptyAction: 'Xidmətlərə bax',

    errorTitle: 'Sifarişlər yüklənmədi',
    errorDescription: 'Bağlantını yoxlayıb yenidən cəhd edin.',

    loadMore: 'Daha çox göstər',
    /** Shown while the *next* page is in flight, under the rows already there. */
    loadingMore: 'Yüklənir…',
  },

  /**
   * All fourteen statuses ([ADR-0015](../../../../docs/decisions/ADR-0015-order-lifecycle-states.md)),
   * including the ones a customer rarely meets.
   *
   * `DRAFT` is here for completeness rather than because it is reachable: order
   * creation lands in `SEARCHING`. Leaving it out would mean a blank card if it
   * ever were reachable, which is the failure this table exists to prevent.
   */
  status: {
    DRAFT: {
      label: 'Qaralama',
      next: 'Bu sifariş hələ göndərilməyib.',
    },
    SEARCHING: {
      label: 'Usta axtarılır',
      next: 'Yaxınlıqdakı ustalara təklif göndərilir. Kimsə qəbul edən kimi xəbər verəcəyik.',
    },
    ACCEPTED: {
      label: 'Usta qəbul etdi',
      next: 'Usta işə hazırlaşır. Yola çıxanda bildiriş alacaqsınız.',
    },
    MASTER_ON_THE_WAY: {
      label: 'Usta yoldadır',
      next: 'Usta göstərdiyiniz ünvana gəlir.',
    },
    MASTER_ARRIVED: {
      label: 'Usta gəldi',
      next: 'Usta ünvandadır və işə başlamağı gözləyir.',
    },
    IN_PROGRESS: {
      label: 'İş görülür',
      next: 'Usta işə başlayıb. Bitirəndə xəbər verəcəyik.',
    },
    COMPLETED: {
      label: 'İş bitdi',
      next: 'Usta işi tamamladı.',
    },
    PAYMENT_PENDING: {
      label: 'Ödəniş gözlənilir',
      next: 'İş bitdi, ödəniş hələ tamamlanmayıb.',
    },
    PAID: {
      label: 'Ödənildi',
      next: 'Sifariş bağlandı. Təşəkkür edirik.',
    },
    DISPUTED: {
      label: 'Mübahisə açılıb',
      next: 'Sifariş baxışdadır. Nəticə barədə xəbər verəcəyik.',
    },
    RESOLVED: {
      label: 'Mübahisə həll olundu',
      next: 'Baxış başa çatdı.',
    },
    REFUNDED: {
      label: 'Məbləğ qaytarıldı',
      next: 'Ödəniş sizə geri qaytarıldı.',
    },
    NO_MASTER_FOUND: {
      label: 'Usta tapılmadı',
      /**
       * **Nobody cancelled anything**, and the wording carries that: the
       * platform had no free master nearby. Saying it any other way would be
       * the verbal form of the conflation this status exists to prevent.
       */
      next: 'Hazırda yaxınlıqda boş usta yoxdur. Bir az sonra yenidən cəhd edə bilərsiniz.',
    },
    CANCELLED: {
      label: 'Ləğv edildi',
      next: 'Bu sifariş ləğv olunub.',
    },
  },
} as const;
