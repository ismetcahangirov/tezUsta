/**
 * Every word the saved-addresses screen puts in front of a customer, in one
 * file — the same shape as `service-catalogue-copy.ts`.
 *
 * **These strings are placeholders awaiting the owner's approval.** CLAUDE.md
 * §17 and `docs/design/design-system.md` §9 reserve the *content* of an empty
 * or failed state — its words, as distinct from the components it is built
 * from — to the owner. Nothing here is a design token and nothing here was
 * researched; it is the plainest factual Azerbaijani that makes the screen
 * usable while the real copy is decided. Every string in this file is listed
 * on the pull request under "Copy proposed for the owner to accept or
 * replace".
 *
 * **Not a translation layer.** When TezUsta picks its launch languages and
 * adds a real i18n layer, this file is what moves into it.
 */
export const ADDRESSES_COPY = {
  /** The screen's own heading. */
  title: 'Ünvanlarım',

  /** Shown while the first load is in flight, for a screen reader only. */
  loading: 'Ünvanlar yüklənir',

  /** The customer has no saved addresses at all. */
  emptyTitle: 'Hələ ünvan yoxdur',
  emptyDescription: 'Sifariş vermək üçün ünvan əlavə edin.',

  /** The first load failed and there is nothing cached to show instead. */
  errorTitle: 'Ünvanlar yüklənmədi',
  errorDescription: 'İnternet bağlantısını yoxlayıb yenidən cəhd edin.',
  retry: 'Yenidən cəhd et',

  /** A refresh failed but a previously loaded list is still in memory. */
  staleNotice: 'Bağlantı yoxdur — saxlanmış siyahı göstərilir.',

  /** Opens the add-address form. */
  addAction: 'Ünvan əlavə et',

  /** Tags the one address `isDefault` is true for. */
  defaultBadge: 'Defolt',
  /** Accessibility labels for a row's actions — each takes the row's own title. */
  setDefaultAction: (title: string): string => `${title} ünvanını defolt et`,
  editAction: (title: string): string => `${title} ünvanını redaktə et`,
  deleteAction: (title: string): string => `${title} ünvanını sil`,

  formTitleAdd: 'Yeni ünvan',
  formTitleEdit: 'Ünvanı redaktə et',
  labelField: 'Ad (məs. Ev, İş)',
  addressField: 'Ünvan',
  buildingField: 'Bina',
  entranceField: 'Giriş',
  floorField: 'Mərtəbə',
  apartmentField: 'Mənzil',
  landmarkField: 'Əlamətdar yer',

  /** Triggers forward geocoding for whatever is currently typed in `addressField`. */
  findAddressAction: 'Ünvanı tap',
  /** The typed text matched a real place and carries coordinates now. */
  addressFound: 'Ünvan tapıldı.',
  /** Forward geocoding answered `no-result`. */
  geocodeNoResult: 'Bu ünvan tapılmadı. Zəhmət olmasa yenidən yazın.',
  /** Forward geocoding answered `unavailable`, or the request never reached the server. */
  geocodeUnavailable: 'Xəritə xidməti hazırda əlçatan deyil. Bir az sonra yenidən cəhd edin.',

  save: 'Yadda saxla',
  cancel: 'İmtina et',

  /** The per-customer cap (`MAX_SAVED_ADDRESSES` on the API) was reached. */
  tooManyAddresses: 'Maksimum ünvan sayına çatmısınız. Yeni ünvan üçün birini silin.',
  /**
   * The address a row action targeted answered 404 — not the caller's, or
   * already gone. The API returns 404, never 403, for exactly this reason: it
   * is not an account problem, so the copy must not read as one.
   */
  notFoundError: 'Bu ünvan artıq siyahıda yoxdur.',
  offlineError: 'Bağlantı yoxdur. Yenidən cəhd edin.',
  saveError: 'Yadda saxlanmadı. Yenidən cəhd edin.',
  deleteError: 'Silinmədi. Yenidən cəhd edin.',
} as const;
