/**
 * Every word the first-run profile step puts in front of a customer, in one
 * file — the same shape as `addresses-copy.ts`.
 *
 * **These strings are placeholders awaiting the owner's approval.** CLAUDE.md
 * §17 reserves the *content* of a first-run screen to the owner, and this
 * screen is first-run by definition. Nothing here is a design token and
 * nothing here was researched; it is the plainest factual Azerbaijani that
 * makes the step usable while the real copy is decided. Every string in this
 * file is listed on the pull request under "Copy proposed for the owner to
 * accept or replace".
 *
 * **Not a translation layer.** When TezUsta picks its launch languages and
 * adds a real i18n layer, this file is what moves into it.
 */
export const CUSTOMERS_COPY = {
  /** The one question a first-run customer is asked. */
  setupTitle: 'Sizə necə müraciət edək?',
  /**
   * Why it is being asked, in one line. A name is not bureaucracy here: the
   * master who takes the job sees it on the order, so the customer is being
   * told what it is for rather than asked to fill in a form.
   */
  setupDescription: 'Sifarişi götürən usta bu adı görəcək.',
  nameField: 'Ad',
  namePlaceholder: 'Məsələn, Aysel',
  setupAction: 'Davam et',

  /** Shown while the profile check is in flight, for a screen reader only. */
  loading: 'Profil yoxlanılır',

  /** The profile check itself failed — not a 404, which is a missing profile. */
  errorTitle: 'Profil yüklənmədi',
  errorDescription: 'İnternet bağlantısını yoxlayıb yenidən cəhd edin.',
  retry: 'Yenidən cəhd et',

  /** The create request failed for a reason the customer can act on. */
  offlineError: 'Bağlantı yoxdur. Yenidən cəhd edin.',
  saveError: 'Profil yaradılmadı. Yenidən cəhd edin.',
} as const;
