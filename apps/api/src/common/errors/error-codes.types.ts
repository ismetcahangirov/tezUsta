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
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
