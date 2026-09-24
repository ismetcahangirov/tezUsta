/**
 * Each party's review of the other, for one order
 * ([ADR-0042](docs/decisions/ADR-0042-review-policy.md)).
 *
 * **Blind until both have written or the window closes.** A review is sealed
 * when submitted and visible to its author only; it is revealed to the party
 * it is about when the other side's review arrives, or when the seven-day
 * window closes. Everything below is shaped around that: the counterpart's
 * review is simply absent until it is revealed, so there is no field a client
 * could render too early.
 *
 * Restated as literal unions rather than derived from the Drizzle enum, for
 * the reason `order.ts` gives: this package is imported by a React Native
 * bundle.
 */

/**
 * Which side of the order wrote a review. A `customer` review is about the
 * master; a `master` review is about the customer. A role *on this order*, for
 * the reason {@link MessageSenderKind} gives — one person may hold both.
 */
export type ReviewAuthorRole = 'customer' | 'master';

/** One review, as a party to its order may see it. */
export interface Review {
  readonly id: string;
  readonly orderId: string;
  readonly authorRole: ReviewAuthorRole;
  /** 1–5, whole stars only. */
  readonly rating: number;
  /**
   * Plain text written by a person, at most 500 characters, or null. Untrusted:
   * render it as characters, never as markup, and never put it in a push.
   */
  readonly comment: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * When the review became visible to the party it is about, and began to
   * count towards their rating. Null while sealed — and a sealed review is the
   * only kind its author may still edit.
   */
  readonly revealedAt: string | null;
  /**
   * When an admin removed it (ADR-0042 § 7). Only ever non-null on the
   * caller's **own** review: a removed review is withheld from the party it
   * was about, and shown to its author marked as removed so the removal is
   * not a silent disappearance. The reason is an admin record and is not
   * returned here.
   */
  readonly removedAt: string | null;
}

/**
 * Everything one party may know about the reviews on one order —
 * `GET /orders/:orderId/reviews`.
 */
export interface OrderReviews {
  readonly orderId: string;
  /** Which side of this order the caller is on. */
  readonly role: ReviewAuthorRole;
  /** The caller's own review, sealed or revealed, or null if they have not written one. */
  readonly mine: Review | null;
  /**
   * The other party's review — **only once it is revealed and not removed**.
   * Null means "nothing you may see", which covers "not written", "sealed" and
   * "removed" without telling the caller which.
   */
  readonly theirs: Review | null;
  /**
   * When the review window closes: seven days (server configuration) from the
   * moment the order entered `COMPLETED`. Null for an order that has not been
   * completed.
   */
  readonly windowClosesAt: string | null;
  /**
   * Whether `POST /orders/:orderId/review` would currently accept a review from
   * the caller: the order is completed or later, the window is open and the
   * caller has not reviewed it yet. A hint for the UI, never the check.
   */
  readonly canReview: boolean;
  /**
   * Whether `PUT /orders/:orderId/review` would currently accept an edit: the
   * caller's review exists, is still sealed, and the window is open.
   */
  readonly canEdit: boolean;
}

/**
 * The body of `POST /orders/:orderId/review` and `PUT /orders/:orderId/review`.
 * The author's side is decided by the server from who is asking, never sent.
 */
export interface SubmitReviewRequest {
  /** An integer from 1 to 5. */
  readonly rating: number;
  /**
   * Optional. Trimmed, control characters other than newline stripped, at
   * most 500 characters; empty becomes null. On an edit, omitting it or
   * sending null clears the comment — the body is the whole review.
   */
  readonly comment?: string | null;
}

/**
 * A party's rating as the other side of an order sees it (ADR-0042 § 6,
 * issue #225): the average of revealed, unremoved reviews about them, to two
 * decimals, and how many there are. **Null average, not zero, with no
 * reviews** — the same rule as `Master.ratingAverage`: no reviews is not a bad
 * score. Always shown with its count.
 */
export interface PartyRating {
  readonly ratingAverage: number | null;
  readonly ratingCount: number;
}

/**
 * The body of `POST /admin/ratings/recalculate` (issue #223): one master, one
 * customer, or — with neither — every profile. Naming both is refused.
 */
export interface RecalculateRatingsRequest {
  readonly masterId?: string | undefined;
  readonly customerId?: string | undefined;
}

/**
 * What a recalculation did: how many stored aggregates differed from the sum
 * over revealed, unremoved reviews and were corrected. Zero and zero is a
 * healthy system.
 */
export interface RatingRecalculation {
  readonly scope: 'all' | 'master' | 'customer';
  readonly mastersCorrected: number;
  readonly customersCorrected: number;
}

/**
 * A review as an admin sees it (issue #224, ADR-0042 § 7): everything, including
 * who it is between and, for a removed review, who removed it and why.
 *
 * `comment` is untrusted text written by a person; the admin panel (EPIC 13)
 * must render it escaped, never as markup.
 */
export interface AdminReview extends Review {
  readonly customerId: string;
  readonly masterId: string;
  readonly removedByAdminId: string | null;
  readonly removalReason: string | null;
}

/** The body of `POST /admin/reviews/:id/removal`. The reason is mandatory. */
export interface RemoveReviewRequest {
  readonly reason: string;
}
