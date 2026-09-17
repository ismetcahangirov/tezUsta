/**
 * Every word the catalogue screen puts in front of a customer, in one file.
 *
 * **These strings are placeholders awaiting the owner's approval, and they are
 * gathered here so that approving or replacing them is one review of one
 * file.** `CLAUDE.md` §17 and `docs/design/design-system.md` §9 both reserve
 * the *content* of an empty state — its words, as distinct from the components
 * it is assembled from — to the owner. Nothing here is a design token and
 * nothing here was researched; they are the plainest factual Azerbaijani that
 * makes the screen usable while the real copy is decided.
 *
 * **This is not a translation layer.** Category and service names come from the
 * API already resolved for the device's language (ADR-0019); these are the
 * screen's own chrome. When TezUsta picks its launch languages and adds a real
 * i18n layer, this file is what moves into it — which is the other reason for
 * keeping it in one place rather than scattering literals through components.
 */
export const SERVICE_CATALOGUE_COPY = {
  /** The screen's own heading. */
  title: 'Nə lazımdır?',

  /** Shown while the first load is in flight, for a screen reader only. */
  loading: 'Kataloq yüklənir',

  /** The catalogue loaded and is genuinely empty — no active services at all. */
  emptyTitle: 'Hazırda xidmət yoxdur',
  emptyDescription: 'Kataloq tezliklə dolacaq.',

  /** A category was opened and has nothing active in it. */
  emptyCategoryTitle: 'Bu kateqoriyada xidmət yoxdur',

  /** The first load failed and there is nothing cached to show instead. */
  errorTitle: 'Kataloq yüklənmədi',
  errorDescription: 'İnternet bağlantısını yoxlayıb yenidən cəhd edin.',
  retry: 'Yenidən cəhd et',

  /** A refresh failed but a previously loaded catalogue is still in memory. */
  staleNotice: 'Bağlantı yoxdur — saxlanmış siyahı göstərilir.',

  /** Rendered instead of an amount for an inspection-priced service. */
  priceAfterInspection: 'Qiymət baxışdan sonra',

  /** Prefix for a reference price: the master sets the real one (ADR-0010). */
  priceFrom: (amount: string): string => `${amount}-dən`,

  /** Returns to the full catalogue from inside a category. */
  allCategories: 'Bütün kateqoriyalar',
} as const;
