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
   * [ADR-0060](docs/decisions/ADR-0060-inspection-price-approval.md), the
   * inspection price. Three codes because the app shows three different
   * things:
   *
   * - `ORDER_PRICE_NOT_APPROVED`: the master tried to start an
   *   inspection-priced job whose quote the customer has not approved. The
   *   app shows "waiting for the customer", not an error.
   * - `ORDER_PRICE_NOT_QUOTABLE`: this order cannot be quoted now. It is
   *   fixed-priced, not `MASTER_ARRIVED`, or already approved. Retrying will
   *   not help.
   * - `ORDER_PRICE_STALE`: the customer approved or declined an amount that
   *   is no longer the quote, because the master changed it, or the order
   *   moved. `details` carries the current quote and status so the app can
   *   show the new figure instead of guessing.
   */
  ORDER_PRICE_NOT_APPROVED: 'ORDER_PRICE_NOT_APPROVED',
  ORDER_PRICE_NOT_QUOTABLE: 'ORDER_PRICE_NOT_QUOTABLE',
  ORDER_PRICE_STALE: 'ORDER_PRICE_STALE',

  /**
   * [ADR-0068](docs/decisions/ADR-0068-cancellation-rules.md) § 4. The
   * assigned master tried to hand the order back after their window closed.
   * Its own code, not `ORDER_INVALID_TRANSITION`: the edge exists and an admin
   * may still drive it, and the app answers with "contact support", not with
   * a refetch. `details.windowSeconds` lets it say how long the window was.
   */
  ORDER_HANDBACK_WINDOW_CLOSED: 'ORDER_HANDBACK_WINDOW_CLOSED',

  /**
   * Issue #83. A specific code rather than the generic `CONFLICT` every other
   * order-photo error reuses, because the acceptance criteria call for one: a
   * client hitting the per-order cap needs to distinguish "you may not attach
   * any more photos to this order" from every other reason an attach can fail
   * (not confirmed yet, already attached elsewhere, not yours).
   */
  ORDER_PHOTO_LIMIT_EXCEEDED: 'ORDER_PHOTO_LIMIT_EXCEEDED',

  /**
   * Issue #273. The customer already holds `MAX_OPEN_ORDERS_PER_CUSTOMER`
   * orders in `SEARCHING` or an engaged status. Its own code rather than
   * `CONFLICT` because the app says something specific — finish or cancel one
   * first — and must not offer a retry that cannot succeed until then.
   */
  OPEN_ORDER_LIMIT_EXCEEDED: 'OPEN_ORDER_LIMIT_EXCEEDED',

  /**
   * Issue #397. The search radar's read asked about an order that is no
   * longer `SEARCHING` (ADR-0055 § 5). Its own code because the app treats it
   * as "the order moved on" and swaps the card, not as an error to show.
   */
  ORDER_NOT_SEARCHING: 'ORDER_NOT_SEARCHING',

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
   *   range). The job may still be there;
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
   * Issue #318. A photo named on a message is confirmed but still being
   * re-encoded without its metadata, which takes seconds. Its own code
   * rather than `CONFLICT` because the app has one specific thing to do:
   * send the same message again shortly. Every other 409 on this endpoint
   * means sending it again will fail the same way.
   */
  MESSAGE_ATTACHMENT_PROCESSING: 'MESSAGE_ATTACHMENT_PROCESSING',

  /**
   * Issue #318. A photo named on a message could not be re-encoded (not a
   * decodable image, or too many pixels), so it can never be sent. The app
   * drops it from the composer; the server has already deleted the upload.
   */
  MESSAGE_ATTACHMENT_UNUSABLE: 'MESSAGE_ATTACHMENT_UNUSABLE',

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
   * #330, ADR-0053. A party's report about the other party on one order:
   *
   * - `REPORT_WINDOW_CLOSED` — the review window has passed since the order ended.
   * - `REPORT_NO_OTHER_PARTY` — nobody is on the other side yet: an order no
   *   master has accepted has no master to report.
   * - `REPORT_ALREADY_FILED` — this side has reported this order; it edits
   *   the report it has instead.
   * - `REPORT_NOT_EDITABLE` — an admin has picked the report up.
   * - `REPORT_OUTCOME_NOT_TAKEN` — a suspension outcome names an action the
   *   reported party's account does not show.
   */
  REPORT_WINDOW_CLOSED: 'REPORT_WINDOW_CLOSED',
  REPORT_NO_OTHER_PARTY: 'REPORT_NO_OTHER_PARTY',
  REPORT_ALREADY_FILED: 'REPORT_ALREADY_FILED',
  REPORT_NOT_EDITABLE: 'REPORT_NOT_EDITABLE',
  REPORT_OUTCOME_NOT_TAKEN: 'REPORT_OUTCOME_NOT_TAKEN',

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
  /**
   * #329. A signed-in admin's password change, refused: the current password
   * or the code was wrong. One code for both, so a stolen session cannot use
   * the form to test password guesses without the authenticator.
   */
  ADMIN_CREDENTIALS_INVALID: 'ADMIN_CREDENTIALS_INVALID',
  ADMIN_LAST_SUPER_ADMIN: 'ADMIN_LAST_SUPER_ADMIN',
  ADMIN_EMAIL_TAKEN: 'ADMIN_EMAIL_TAKEN',

  /**
   * EPIC 13 (issue #244). A catalogue category or service slug that another
   * row already has. Its own code so the editor can put the message on the
   * slug field instead of a generic conflict banner.
   */
  CATALOGUE_SLUG_TAKEN: 'CATALOGUE_SLUG_TAKEN',

  /**
   * EPIC 13 (issue #245, ADR-0043 § 5). An admin asked to close a dispute as
   * `REFUNDED`. Withheld indefinitely since
   * [ADR-0046](docs/decisions/ADR-0046-subscription-only-monetisation.md) § 4:
   * the platform never holds order money, so it never has a refund to issue.
   * Its own code so the panel can say why.
   */
  REFUND_NOT_AVAILABLE: 'REFUND_NOT_AVAILABLE',

  /**
   * Issue #333 ([ADR-0046](docs/decisions/ADR-0046-subscription-only-monetisation.md)
   * § 4). An admin asked to move an order to `PAYMENT_PENDING` or `PAID`. The
   * customer pays the master directly and the platform records no payment, so
   * either status would put a payment nobody saw into the history and the
   * audit log. 409 like `REFUND_NOT_AVAILABLE`, its sibling: the request is
   * well formed, and the platform's own state is what refuses it.
   */
  ORDER_PAYMENT_NOT_TRACKED: 'ORDER_PAYMENT_NOT_TRACKED',

  /**
   * Issue #274 ([ADR-0044](docs/decisions/ADR-0044-location-plausibility.md)).
   * A position report that implies the master moved faster than any road
   * allows since their previous one. 422 rather than `VALIDATION_FAILED`:
   * the body is well formed, and the master's app has one specific thing to do
   * about it — drop that fix and carry on reporting — which it can only do if
   * it can tell this apart from a malformed request it would have to fix.
   */
  LOCATION_IMPLAUSIBLE: 'LOCATION_IMPLAUSIBLE',

  /**
   * Issue #322 ([ADR-0046](docs/decisions/ADR-0046-subscription-only-monetisation.md)
   * § 5). The master's subscription does not entitle them to work: it expired,
   * or they never had one. Refuses going available and accepting an offer —
   * never finishing a job already accepted. Its own code so the app can say
   * why the feed is empty (#325) rather than show nothing.
   */
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',

  /**
   * Issue #322. A period was bought while another bought period is already
   * waiting to start. Prepaid stacking holds one queued period.
   */
  SUBSCRIPTION_PERIOD_ALREADY_QUEUED: 'SUBSCRIPTION_PERIOD_ALREADY_QUEUED',

  /**
   * Issue #323. A checkout while purchases are closed — the admin switch is
   * off, or the period has no current price (ADR-0046 § 5).
   */
  SUBSCRIPTION_PURCHASES_CLOSED: 'SUBSCRIPTION_PURCHASES_CLOSED',

  /** Issue #322. A cancellation of a trial, an expired subscription, or one already cancelled. */
  SUBSCRIPTION_TRANSITION_NOT_ALLOWED: 'SUBSCRIPTION_TRANSITION_NOT_ALLOWED',

  /**
   * Issue #324. Editing the subscription offer from the admin panel. Each is
   * its own code because each has a different fix in the dialog: withdraw
   * the scheduled price first, pick a later date, confirm the amount, enter
   * the prices before opening sales.
   */
  SUBSCRIPTION_PRICE_ALREADY_SCHEDULED: 'SUBSCRIPTION_PRICE_ALREADY_SCHEDULED',
  /** 422: a paid-for period's price changes no sooner than the notice period (ADR-0046 § 5). */
  SUBSCRIPTION_PRICE_NOTICE_REQUIRED: 'SUBSCRIPTION_PRICE_NOTICE_REQUIRED',
  /** 422: `effectiveFrom` is in the past or more than a year ahead. */
  SUBSCRIPTION_PRICE_EFFECTIVE_FROM_INVALID: 'SUBSCRIPTION_PRICE_EFFECTIVE_FROM_INVALID',
  /** 422: a price that at least doubles or halves needs `confirmLargeChange` — the 1000-for-10.00 typo guard. */
  SUBSCRIPTION_PRICE_CONFIRMATION_REQUIRED: 'SUBSCRIPTION_PRICE_CONFIRMATION_REQUIRED',
  /** 409: only a scheduled price that has not taken effect can be withdrawn. */
  SUBSCRIPTION_PRICE_NOT_SCHEDULED: 'SUBSCRIPTION_PRICE_NOT_SCHEDULED',
  /** 409: purchases cannot open while either billing period has no current price. */
  SUBSCRIPTION_PURCHASES_NEED_PRICES: 'SUBSCRIPTION_PURCHASES_NEED_PRICES',

  /**
   * #308, ADR-0045 § 3–4. The master's own portfolio. Each is its own code
   * because the editor says something different for each:
   *
   * - `PORTFOLIO_MASTER_NOT_ACTIVE` — 403: only an active, verified master
   *   writes to a portfolio. A suspended or unverified master still reads
   *   their own posts.
   * - `PORTFOLIO_SERVICE_NOT_OFFERED` — the tag names a service the master
   *   does not offer.
   * - `PORTFOLIO_POST_NOT_EDITABLE` — the post is past the step this asks
   *   for: photos change only on a draft, and a removed post not at all.
   * - `PORTFOLIO_POST_NOT_READY` — publish with no photos, or with a photo
   *   not uploaded or failed.
   * - `PORTFOLIO_POST_LIMIT_EXCEEDED` — `PORTFOLIO_MAX_POSTS` reached.
   * - `PORTFOLIO_MEDIA_LIMIT_EXCEEDED` — `PORTFOLIO_MAX_ITEMS_PER_POST` reached.
   * - `PORTFOLIO_MEDIA_POSITION_TAKEN` — another photo holds that place.
   * - `PORTFOLIO_MEDIA_NOT_UPLOADED` — confirm before the bytes arrived.
   * - `PORTFOLIO_MEDIA_ALREADY_CONFIRMED` — confirm twice.
   * - `PORTFOLIO_MEDIA_TOO_LARGE` — over `PORTFOLIO_IMAGE_MAX_BYTES`.
   * - `PORTFOLIO_MEDIA_HEIC_UNSUPPORTED` — an iPhone HEIC; the app converts
   *   first (#319), so this means the conversion was skipped.
   * - `PORTFOLIO_MEDIA_CONTENT_MISMATCH` — not a JPEG, PNG or WebP, or not
   *   the type it was presigned as.
   */
  PORTFOLIO_MASTER_NOT_ACTIVE: 'PORTFOLIO_MASTER_NOT_ACTIVE',
  PORTFOLIO_SERVICE_NOT_OFFERED: 'PORTFOLIO_SERVICE_NOT_OFFERED',
  PORTFOLIO_POST_NOT_EDITABLE: 'PORTFOLIO_POST_NOT_EDITABLE',
  PORTFOLIO_POST_NOT_READY: 'PORTFOLIO_POST_NOT_READY',
  PORTFOLIO_POST_LIMIT_EXCEEDED: 'PORTFOLIO_POST_LIMIT_EXCEEDED',
  PORTFOLIO_MEDIA_LIMIT_EXCEEDED: 'PORTFOLIO_MEDIA_LIMIT_EXCEEDED',
  PORTFOLIO_MEDIA_POSITION_TAKEN: 'PORTFOLIO_MEDIA_POSITION_TAKEN',
  PORTFOLIO_MEDIA_NOT_UPLOADED: 'PORTFOLIO_MEDIA_NOT_UPLOADED',
  PORTFOLIO_MEDIA_ALREADY_CONFIRMED: 'PORTFOLIO_MEDIA_ALREADY_CONFIRMED',
  PORTFOLIO_MEDIA_TOO_LARGE: 'PORTFOLIO_MEDIA_TOO_LARGE',
  PORTFOLIO_MEDIA_HEIC_UNSUPPORTED: 'PORTFOLIO_MEDIA_HEIC_UNSUPPORTED',
  PORTFOLIO_MEDIA_CONTENT_MISMATCH: 'PORTFOLIO_MEDIA_CONTENT_MISMATCH',

  /**
   * #309. One avatar upload at a time: the previous one is uploaded or still
   * processing. A presign never uploaded is replaced instead. The avatar's
   * other refusals are the portfolio's codes above.
   */
  AVATAR_UPLOAD_IN_PROGRESS: 'AVATAR_UPLOAD_IN_PROGRESS',

  /**
   * #312, ADR-0045 § 6, § 8. Moderation refusals, each a different sentence in
   * the panel:
   *
   * - `PORTFOLIO_POST_ALREADY_REMOVED` — removal is not idempotent on
   *   purpose: the first removal's admin and reason are the record.
   * - `PORTFOLIO_POST_NOT_REMOVABLE` — only a published post is shown to
   *   anyone, so only a published post is removed.
   * - `MASTER_AVATAR_NOT_SET` — there is no avatar to remove.
   */
  PORTFOLIO_POST_ALREADY_REMOVED: 'PORTFOLIO_POST_ALREADY_REMOVED',
  PORTFOLIO_POST_NOT_REMOVABLE: 'PORTFOLIO_POST_NOT_REMOVABLE',
  MASTER_AVATAR_NOT_SET: 'MASTER_AVATAR_NOT_SET',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
