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
} as const;
