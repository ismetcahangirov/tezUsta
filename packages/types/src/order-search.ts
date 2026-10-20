/**
 * What the customer's search radar reads while their order is `SEARCHING`
 * (`GET /orders/:id/search`, issue #397,
 * [ADR-0055](docs/decisions/ADR-0055-search-radar-and-arrival-promise.md)).
 *
 * **No master is identified anywhere in this shape.** No id, name, rating or
 * distance, and no coordinate that is a master's own: every point is the
 * centre of a cell on a fixed global grid of 0.005° rows (ADR-0055 § 3), so
 * the same master lands in the same cell whoever is asking, and repeated reads
 * never narrow below one cell.
 */
export interface OrderSearchProgress {
  /** 1-based broadcast round, derived from the clock as dispatch derives it. */
  readonly round: number;
  /** The radius the search has reached now, in metres: the ring. */
  readonly radiusM: number;
  /** `DISPATCH_MAX_RADIUS_M`, so the ring can be drawn to scale. */
  readonly maxRadiusM: number;
  /** ISO-8601. When the search gives up if nobody accepts. */
  readonly endsAt: string;
  /**
   * Masters the **current** search has offered this order to, including those
   * who declined or let the offer lapse. Never decreases during a search, and
   * counts masters who are not drawn.
   */
  readonly offeredCount: number;
  /** Cell centres, deduplicated, nearest the address first, at most 12. */
  readonly cells: readonly OrderSearchCell[];
}

/** One coarse cell holding at least one reached master. A cell centre, never a position. */
export interface OrderSearchCell {
  readonly latitude: number;
  readonly longitude: number;
}
