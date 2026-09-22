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
  /**
   * The tab's label, which is not the screen's heading
   * ([ADR-0030](../../../../docs/decisions/ADR-0030-customer-root-navigation-and-order-list.md)).
   * A tab bar has room for a destination's name and none for a question.
   */
  tab: 'Ana səhifə',
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

  /**
   * Qualifies a reference price. **The most owner-owned string in this file.**
   *
   * A catalogue amount is not the price: the master who accepts sets that
   * ([ADR-0010](docs/decisions/ADR-0010-pricing-and-commission.md)), so
   * rendering the bare figure would tell a customer something the platform
   * cannot promise. *How* to qualify it is a pricing-presentation decision
   * nobody has made.
   *
   * A suffixed form (`25,00 ₼-dən`) was tried and abandoned: the Azerbaijani
   * ablative attaches to the currency **symbol** and has to obey vowel
   * harmony, so the correct suffix differs by currency and `-dən` is simply
   * wrong after a back vowel. A separate preceding word sidesteps grammar the
   * app has no business generating.
   */
  priceFrom: (amount: string): string => `minimum ${amount}`,

  /** Returns to the full catalogue from inside a category. */
  allCategories: 'Bütün kateqoriyalar',
} as const;
