/**
 * Stable, machine-readable error codes returned in every API error envelope
 * (see `docs/architecture/backend-architecture.md` § Error model). Declared
 * as a `const` object + derived union so a client can `switch` on a value the
 * compiler knows, rather than a loose string.
 *
 * This union lives here today and moves to `packages/types` the moment
 * `apps/mobile` consumes the API directly — one definition either way, never
 * two (ADR-0016).
 *
 * Seeded with what issue #19 (API scaffold) actually needs: the one
 * unexpected-error fallback, the one validation-failure code, and the generic
 * codes for the HTTP statuses the global filter already has to map per the
 * doc's status table (400/401/403/404/409/422/429/500). None of these are
 * business-domain codes — order/payment-specific codes (e.g.
 * `ORDER_ALREADY_TAKEN`) belong to the Epics that introduce those errors.
 */
export const ERROR_CODES = {
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  /**
   * 413: a body over the route's parser limit (issue #186 — the LiveKit
   * webhook's 64 KiB cap is the first route with a limit below Fastify's
   * default). Its own code so a client is not told `INTERNAL_ERROR` for a
   * request it can fix by sending less.
   */
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',

  /**
   * EPIC 6 (issue #80). The first business-domain codes in this union, added
   * by the Epic that introduces the errors, exactly as the note above says
   * they should be.
   *
   * They are distinguishable on purpose. `ORDER_INVALID_TRANSITION` means the
   * order cannot reach that state from where it is — retrying will never help.
   * `ORDER_TRANSITION_NOT_PERMITTED` means it can, but not for this caller —
   * the same request from the assigned master would succeed. A client that saw
   * `CONFLICT` for both would have to guess which screen to show.
   */
  ORDER_INVALID_TRANSITION: 'ORDER_INVALID_TRANSITION',
  ORDER_TRANSITION_NOT_PERMITTED: 'ORDER_TRANSITION_NOT_PERMITTED',

  /**
   * Issue #83. A specific code rather than the generic `CONFLICT` every other
   * order-photo error reuses, because the acceptance criteria call for one: a
   * client hitting the per-order cap needs to distinguish "you may not attach
   * any more photos to this order" from every other reason an attach can fail
   * (not confirmed yet, already attached elsewhere, not yours).
   */
  ORDER_PHOTO_LIMIT_EXCEEDED: 'ORDER_PHOTO_LIMIT_EXCEEDED',

  /**
   * EPIC 7 (issue #101). The master-facing dispatch surface, added by the Epic
   * that introduces the errors — the note at the top of this file names
   * `ORDER_ALREADY_TAKEN` as the example of a code that belongs to its own
   * Epic, and this is that Epic.
   *
   * All four are distinguishable because a master's app shows a different
   * screen for each, and a single `CONFLICT` would make it guess:
   *
   * - `ORDER_ALREADY_TAKEN` — somebody else won the race
   *   ([ADR-0009](docs/decisions/ADR-0009-dispatch-model.md)). The offer is
   *   gone and nothing the master does brings it back. This is the **expected**
   *   outcome for every loser of a broadcast, which is exactly why it is a
   *   named code rather than a bare 409: on this dispatch model most accepts
   *   lose, and "a stale offer that fails on tap is a support ticket" unless
   *   the app can say precisely what happened.
   * - `OFFER_NO_LONGER_ACTIONABLE` — this master's own offer row has already
   *   moved on: it expired, or they declined it. Not a race, and a different
   *   sentence to show.
   * - `MASTER_NOT_ELIGIBLE_FOR_OFFER` — the offer was real but this master no
   *   longer satisfies the dispatch predicate (went offline, drove out of
   *   range, passed the commission-debt ceiling). The job may still be there;
   *   the master is what changed.
   * - `MASTER_HAS_ACTIVE_ORDER` — the `orders_one_active_per_master` partial
   *   unique index. A raw constraint violation would surface as a 500 saying
   *   nothing; this says the one true thing, which is "finish the job you are
   *   on".
   */
  ORDER_ALREADY_TAKEN: 'ORDER_ALREADY_TAKEN',
  OFFER_NO_LONGER_ACTIONABLE: 'OFFER_NO_LONGER_ACTIONABLE',
  MASTER_NOT_ELIGIBLE_FOR_OFFER: 'MASTER_NOT_ELIGIBLE_FOR_OFFER',
  MASTER_HAS_ACTIVE_ORDER: 'MASTER_HAS_ACTIVE_ORDER',

  /**
   * EPIC 10 (issue #143). A named code rather than the generic `CONFLICT`,
   * because the settings screen shows a different thing for it: the toggle is
   * disabled and the reason is that the category is transactional, not that
   * something raced. A client that saw `CONFLICT` would have to guess which of
   * the two it was looking at, and would most likely show a retry.
   */
  NOTIFICATION_CATEGORY_NOT_CHANGEABLE: 'NOTIFICATION_CATEGORY_NOT_CHANGEABLE',

  /**
   * EPIC 18 (issue #178). The order is finished, so its conversation is a
   * transcript rather than a channel
   * ([ADR-0033](docs/decisions/ADR-0033-in-order-messaging.md) § 2).
   *
   * A named code rather than the generic `CONFLICT` for the reason
   * `ORDER_PHOTO_LIMIT_EXCEEDED` is one: the app has a specific thing to do
   * about it — drop the composer and keep the history — and it must not be
   * confused with the refusals that mean "try again". Reaching this at all is
   * a client whose cached `writable` flag went stale, which is expected and
   * is why the flag is documented as a hint rather than the check.
   */
  CONVERSATION_NOT_WRITABLE: 'CONVERSATION_NOT_WRITABLE',

  /**
   * Issue #185. `POST /calls/:id/join` on a call the caller *is* a party to,
   * but that is not answered — still ringing, or already over — or whose order
   * has stopped being live. Distinct from the 404 a stranger gets: by the time
   * this is reached the caller has proven the call is theirs, so its existence
   * is not the secret; the refusal is that there is no room to join.
   */
  CALL_NOT_JOINABLE: 'CALL_NOT_JOINABLE',

  /**
   * EPIC 11 (issue #222, ADR-0042). Four refusals a party to an order can meet
   * when reviewing it, each reached only after the caller has been proven a
   * party — a stranger gets the one 404. Distinct because the app shows a
   * different sentence for each, and none of them means "try again":
   *
   * - `ORDER_NOT_REVIEWABLE` — the order has not been completed.
   * - `REVIEW_WINDOW_CLOSED` — the seven days from completion have passed.
   * - `REVIEW_ALREADY_SUBMITTED` — this side has reviewed the order; a sealed
   *   review is edited with `PUT`, not written again.
   * - `REVIEW_ALREADY_REVEALED` — the review has been published and is frozen
   *   (ADR-0042 § 4).
   */
  ORDER_NOT_REVIEWABLE: 'ORDER_NOT_REVIEWABLE',
  REVIEW_WINDOW_CLOSED: 'REVIEW_WINDOW_CLOSED',
  REVIEW_ALREADY_SUBMITTED: 'REVIEW_ALREADY_SUBMITTED',
  REVIEW_ALREADY_REVEALED: 'REVIEW_ALREADY_REVEALED',

  /**
   * Issue #224. An admin asked to remove a review that is already removed.
   * Its own code rather than `CONFLICT`, because removal is not idempotent on
   * purpose: the first removal's admin and reason are the record, and a
   * second one silently succeeding would suggest it had replaced them.
   */
  REVIEW_ALREADY_REMOVED: 'REVIEW_ALREADY_REMOVED',

  /**
   * EPIC 13 (issue #240, ADR-0043 § 3). Admin account setup.
   *
   * - `ADMIN_SETUP_LINK_INVALID` — one answer for a link that is unknown,
   *   expired, used, revoked, or for a disabled account. Telling those apart
   *   would say which links were once real.
   * - `ADMIN_TOTP_CODE_INVALID` — the link is fine; the authenticator code is
   *   not. Distinct so the setup page asks for the code again instead of
   *   telling the admin their link is dead.
   */
  ADMIN_SETUP_LINK_INVALID: 'ADMIN_SETUP_LINK_INVALID',
  ADMIN_TOTP_CODE_INVALID: 'ADMIN_TOTP_CODE_INVALID',

  /**
   * EPIC 13 (issue #242, ADR-0043 § 1). Admin account management refusals,
   * each a different sentence in the panel and none a retry:
   *
   * - `ADMIN_SELF_ACTION_REFUSED` — disabling, re-roling or resetting your own
   *   account; another super admin must do it.
   * - `ADMIN_LAST_SUPER_ADMIN` — the change would leave no active super admin.
   * - `ADMIN_EMAIL_TAKEN` — an invitation for an email a live admin already has.
   */
  ADMIN_SELF_ACTION_REFUSED: 'ADMIN_SELF_ACTION_REFUSED',
  ADMIN_LAST_SUPER_ADMIN: 'ADMIN_LAST_SUPER_ADMIN',
  ADMIN_EMAIL_TAKEN: 'ADMIN_EMAIL_TAKEN',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
