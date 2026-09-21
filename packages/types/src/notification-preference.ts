/**
 * What a user can be notified about, as one switch in their settings.
 *
 * **A category is a switch, not an event.** Several notification kinds may
 * share one — the four master-driven progress steps are one line in a settings
 * screen, not four — so this union is the client's vocabulary and
 * `NotificationKind` stays the server's. The mapping between them lives in
 * `apps/api/src/modules/notifications/notification.types.ts`, where a kind
 * without a category does not compile.
 *
 * **Adding a member is a contract change, and the absence of a stored row is
 * what makes it cheap.** A preference is stored only when a user has expressed
 * one, so a new category arrives with its default already applied to everybody
 * and needs no backfill.
 *
 * Two categories the Epic's event list implies are deliberately absent, for
 * the reason their kinds are: "master nearby" needs a live position stream
 * (EPIC 9) and "review reminder" needs reviews (EPIC 11). Each arrives with
 * its own Epic rather than ahead of it.
 */
export type NotificationCategory =
  /** To a master: a broadcast reached them and there is work nearby. */
  | 'order-offers'
  /** To the customer: a master took the job. */
  | 'order-accepted'
  /** To the customer: the assigned master moved the order along. */
  | 'order-progress'
  /** To the counterparty: the order was cancelled. */
  | 'order-cancelled'
  /** To the customer: the search ended with nobody. */
  | 'order-no-master-found';

/**
 * One category as the API reports it.
 *
 * **`changeable` comes from the server rather than from a list the client
 * hardcodes.** Whether a category may be switched off is a product rule, and
 * a client that knew the rule would have to ship a new binary each time the
 * rule moved — while a client that asks gets the current answer and renders a
 * disabled toggle for it. Tightening or relaxing the rule stays a server
 * change, which is the whole point of sending the flag.
 */
export interface NotificationPreference {
  readonly category: NotificationCategory;
  /** Whether this user currently receives this category. */
  readonly enabled: boolean;
  /**
   * Whether this user may switch it off.
   *
   * `false` means the category is transactional: it reports the outcome of
   * something the user themselves asked for, and silencing it makes the
   * product look broken rather than quiet. A write that tries to switch off a
   * category with `changeable: false` is refused by the API.
   */
  readonly changeable: boolean;
}

/** One requested change. The API accepts a whole set of these at once. */
export interface NotificationPreferenceUpdate {
  readonly category: NotificationCategory;
  readonly enabled: boolean;
}

/**
 * What a client sends to set its preferences.
 *
 * **The body is the complete set, not a patch.** A category the body does not
 * name returns to its default — which is what makes the write idempotent and
 * what lets the stored rows stay sparse. The settings screen renders every
 * category anyway (that is what the read returns), so sending all of them
 * costs nothing and removes the question of what an omitted one means.
 */
export interface NotificationPreferencesUpdate {
  readonly preferences: readonly NotificationPreferenceUpdate[];
}
