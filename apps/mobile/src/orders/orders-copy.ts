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

  createdTitle: 'Sifariş göndərildi',
  createdDescription: 'Yaxınlıqdakı ustalar axtarılır.',
  done: 'Bağla',
} as const;
