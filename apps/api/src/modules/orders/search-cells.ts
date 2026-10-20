import type { OrderSearchCell } from '@tezusta/types';

/**
 * The search radar's coarsening rule, in one pure function
 * ([ADR-0055](docs/decisions/ADR-0055-search-radar-and-arrival-promise.md) § 3).
 *
 * A reached master's position is replaced by the centre of the cell it falls
 * in, on a grid fixed to the globe:
 *
 * - **Rows are 0.005° of latitude** (about 557 m).
 * - **Columns are 0.005° ÷ cos(row centre latitude)** wide, so a cell is about
 *   557 m across at any latitude. At Baku that is about 0.00657° of longitude.
 *
 * **Fixed to the globe, never to the customer.** A grid anchored on the
 * order's address would move with every address, and orders placed from
 * shifted addresses would intersect differently-placed cells down towards a
 * stationary master's real position. Anchored at (0, 0), the same master is in
 * the same cell whoever asks. **A snap, never noise**: random jitter averages
 * out over repeated orders, a snap does not.
 *
 * Nothing here logs, and nothing returned is a master's own coordinate.
 */
export const SEARCH_CELL_ROW_DEGREES = 0.005;

/** At most this many points are drawn; the count carries the rest (ADR-0055 § 3). */
export const SEARCH_CELL_LIMIT = 12;

/** A cell on the grid: its integer indices, and the centre that is drawn. */
export interface SearchCell {
  readonly row: number;
  readonly column: number;
  readonly centre: OrderSearchCell;
}

interface Point {
  readonly latitude: number;
  readonly longitude: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * The column width, in degrees of longitude, for one row. Taken from the row's
 * **centre** latitude rather than the point's own, so every point in a row
 * shares one column grid and a row's cells tile without gaps or overlaps.
 */
export function searchCellColumnDegrees(row: number): number {
  const centreLatitude = (row + 0.5) * SEARCH_CELL_ROW_DEGREES;
  return SEARCH_CELL_ROW_DEGREES / Math.cos(toRadians(centreLatitude));
}

/** The cell a point falls in. A point on a boundary belongs to the cell above or east of it. */
export function snapToSearchCell(point: Point): SearchCell {
  const row = Math.floor(point.latitude / SEARCH_CELL_ROW_DEGREES);
  const columnDegrees = searchCellColumnDegrees(row);
  const column = Math.floor(point.longitude / columnDegrees);

  return {
    row,
    column,
    centre: {
      latitude: (row + 0.5) * SEARCH_CELL_ROW_DEGREES,
      longitude: (column + 0.5) * columnDegrees,
    },
  };
}

/**
 * Reached masters' positions → the cells the radar draws: snapped,
 * deduplicated, nearest the address first, capped at {@link SEARCH_CELL_LIMIT}.
 *
 * **Sorted by the address, then by row and column**, so the order of the list
 * is a function of the cells alone. It carries no trace of which master
 * produced which cell or in what order they were read.
 *
 * The distance is a flat approximation in metres. It only orders cells within
 * one search's 10 km, where it agrees with a great circle on every ordering
 * that matters.
 */
export function coarsenSearchCells(
  positions: readonly Point[],
  origin: Point,
  limit: number = SEARCH_CELL_LIMIT,
): OrderSearchCell[] {
  const cells = new Map<string, SearchCell>();
  for (const position of positions) {
    const cell = snapToSearchCell(position);
    cells.set(`${String(cell.row)}:${String(cell.column)}`, cell);
  }

  const cosOrigin = Math.cos(toRadians(origin.latitude));
  const distanceSquared = (cell: SearchCell): number => {
    const north = cell.centre.latitude - origin.latitude;
    const east = (cell.centre.longitude - origin.longitude) * cosOrigin;
    return north * north + east * east;
  };

  return [...cells.values()]
    .sort((a, b) => distanceSquared(a) - distanceSquared(b) || a.row - b.row || a.column - b.column)
    .slice(0, limit)
    .map((cell) => cell.centre);
}
