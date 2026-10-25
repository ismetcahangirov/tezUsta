/**
 * Every string the portfolio components show or announce (issue #313), in one
 * file.
 *
 * **Proposed, not settled** — the standing every `*-copy.ts` in this app has.
 * ADR-0054 § "Interim copy" lists each of these for the owner to accept or
 * replace. The two strings it does not list are other screens' wording, so
 * the app says the same thing in both places: `photoFailed` is the order
 * screen's for a photo that did not load (`orders-copy.ts`), and
 * `priceAfterInspection` the catalogue's for a service with no fixed price
 * (`service-catalogue-copy.ts`).
 *
 * The editor (#314) adds six the ADR does not list, each marked **New** below:
 * a refused library permission (the order screen's wording), a selected
 * service for a screen reader (the report form's), and three failures and a
 * not-yet-verified master that the ADR's screens had no words for.
 */
export const PORTFOLIO_COPY = {
  grid: {
    /** A tile's accessibility label (ADR-0054 § 2): "Paylaşım", or "Paylaşım, 3 şəkil". */
    tile: (photoCount: number): string =>
      photoCount > 1 ? `Paylaşım, ${String(photoCount)} şəkil` : 'Paylaşım',
    processing: 'Hazırlanır',
    failed: 'Alınmadı',
  },

  viewer: {
    close: 'Bağla',
    edit: 'Redaktə et',
    delete: 'Sil',
    /** "2 / 5" (ADR-0054 § 3). */
    counter: (current: number, total: number): string => `${String(current)} / ${String(total)}`,
  },

  /** Read by a screen reader where a photo did not load; nothing is drawn but the icon. */
  photoFailed: 'Şəkil açılmadı',

  profile: {
    /** The screen's title for the customer (ADR-0054 § 1). */
    title: 'Usta',
    back: 'Geri',
    worksTitle: 'İşlər',
    /** The customer, on a master with no posts (ADR-0054 § 6). */
    emptyTitle: 'Usta hələ iş nümunəsi paylaşmayıb.',
    errorTitle: 'Profil açılmadı.',
    /** A 404: the window closed, or the master was suspended or deleted (ADR-0054 § 1). */
    goneTitle: 'Bu profil artıq göstərilmir.',
    retry: 'Yenidən cəhd et',
    /** The order screen's row under the master's name (ADR-0054 § 4). */
    entrySubtitle: 'Profilə bax',
    /** The rating's label: hidden on the profile, kept for a screen reader (ADR-0054 § 1). */
    ratingLabel: 'Ustanın reytinqi',
    bioMore: 'Daha çox',
    servicesTitle: 'Xidmətlər',
    /** A service priced at inspection has no amount to show. */
    priceAfterInspection: 'Qiymət baxışdan sonra',
  },

  /** The master's own profile (ADR-0054 § 1, § 6, § 7). */
  own: {
    title: 'Profilim',
    newPost: 'Yeni paylaşım',
    /** Under a disabled "Yeni paylaşım" at `PORTFOLIO_MAX_POSTS`. */
    postLimit: (max: number): string => `Ən çox ${String(max)} paylaşım ola bilər.`,
    emptyTitle: 'Hələ paylaşım yoxdur',
    emptyDescription:
      'Gördüyünüz işlərin şəkillərini paylaşın. Müştərilər sizi daha yaxşı tanıyacaq.',
    /** **New**: a master who is not yet verified, or is suspended (#314). */
    notActive: 'Profiliniz təsdiqlənəndən sonra iş nümunələri paylaşa bilərsiniz.',
    /** **New** (ADR-0063): the Services card's way to the services screen. */
    manageServices: 'Xidmətləri idarə et',
    /** **New** (ADR-0063): the Services card on the master's own profile, before a first service. */
    noServices: 'Hələ xidmət yoxdur.',
  },

  /** The viewer's edit and delete sheets (ADR-0054 § 3, § 5). */
  manage: {
    save: 'Yadda saxla',
    cancel: 'Ləğv et',
    deleteTitle: 'Bu paylaşım silinsin?',
    delete: 'Sil',
    /** **New**: a delete the server refused; the post is back in the grid. */
    deleteFailed: 'Paylaşım silinmədi. Yenidən cəhd edin.',
    /** **New**: a caption the server refused to save. */
    saveFailed: 'Dəyişiklik saxlanmadı. Yenidən cəhd edin.',
  },

  /** The post editor (ADR-0054 § 5). */
  editor: {
    title: 'Yeni paylaşım',
    back: 'Geri',
    addPhotos: (count: number, max: number): string =>
      `Şəkil əlavə et (${String(count)} / ${String(max)})`,
    removePhoto: 'Şəkli çıxar',
    /** A photo's progress bar, for a screen reader: the order screen's wording. */
    uploading: 'Şəkil yüklənir…',
    retryPhoto: 'Yenidən yüklə',
    photoFailed: 'Alınmadı',
    caption: 'Təsvir (istəyə bağlı)',
    /** "44 / 500", under the caption at the right. */
    counter: (count: number, max: number): string => `${String(count)} / ${String(max)}`,
    service: 'Xidmət (istəyə bağlı)',
    /** **New**: a chosen service, for a screen reader (the report form's word). */
    selected: 'seçilib',
    publish: 'Paylaş',
    publishHint: 'Bütün şəkillər yüklənəndə aktiv olur.',
    /** **New**: a publish the server refused; the draft is still there. */
    publishFailed: 'Paylaşmaq alınmadı. Yenidən cəhd edin.',
    /** **New** to this file: the order screen's wording (`orders-copy.ts`). */
    permissionDenied: 'Şəkillərə giriş icazəsi verilmədi.',
    leaveTitle: 'Paylaşım atılsın?',
    leaveDiscard: 'At',
    leaveContinue: 'Davam et',
  },

  /** The master's avatar (ADR-0054 § 7). */
  avatar: {
    change: 'Profil şəklini dəyiş',
    pick: 'Şəkil seç',
    remove: 'Şəkli sil',
    cancel: 'Ləğv et',
    processing: 'Şəkil hazırlanır…',
    failed: 'Şəkil yüklənmədi.',
    retry: 'Yenidən cəhd et',
  },
} as const;
