import { describe, expect, it } from 'vitest';

import {
  SEARCH_CELL_LIMIT,
  SEARCH_CELL_ROW_DEGREES,
  coarsenSearchCells,
  searchCellColumnDegrees,
  snapToSearchCell,
} from './search-cells';

const BAKU = { latitude: 40.372613, longitude: 49.842717 } as const;

/** Metres per degree of latitude, for turning cell sizes into something readable. */
const METRES_PER_DEGREE = 111_320;

describe('search radar cells (ADR-0055 § 3)', () => {
  describe('snapToSearchCell', () => {
    it('replaces a point with its cell centre, half a row and half a column from the edges', () => {
      const cell = snapToSearchCell(BAKU);
      const columnDegrees = searchCellColumnDegrees(cell.row);

      expect(cell.centre.latitude).toBeCloseTo((cell.row + 0.5) * SEARCH_CELL_ROW_DEGREES, 12);
      expect(cell.centre.longitude).toBeCloseTo((cell.column + 0.5) * columnDegrees, 12);
      expect(cell.centre).not.toEqual(BAKU);
      expect(Math.abs(cell.centre.latitude - BAKU.latitude)).toBeLessThanOrEqual(
        SEARCH_CELL_ROW_DEGREES / 2,
      );
      expect(Math.abs(cell.centre.longitude - BAKU.longitude)).toBeLessThanOrEqual(
        columnDegrees / 2,
      );
    });

    it('scales the column by the row’s latitude, so a Baku cell is about 557 m square', () => {
      const { row } = snapToSearchCell(BAKU);
      const columnDegrees = searchCellColumnDegrees(row);
      const centreLatitude = (row + 0.5) * SEARCH_CELL_ROW_DEGREES;

      expect(columnDegrees).toBeCloseTo(0.00657, 4);
      const heightM = SEARCH_CELL_ROW_DEGREES * METRES_PER_DEGREE;
      const widthM = columnDegrees * METRES_PER_DEGREE * Math.cos((centreLatitude * Math.PI) / 180);
      expect(heightM).toBeCloseTo(556.6, 0);
      expect(widthM).toBeCloseTo(heightM, 6);
      // At the equator a column is a row, and it widens towards the poles.
      expect(searchCellColumnDegrees(0)).toBeCloseTo(SEARCH_CELL_ROW_DEGREES, 6);
      expect(searchCellColumnDegrees(12_000)).toBeGreaterThan(columnDegrees);
    });

    it('puts a point exactly on a row boundary in the cell above it, and just below in the one below', () => {
      const boundary = 8_075 * SEARCH_CELL_ROW_DEGREES; // 40.375
      const on = snapToSearchCell({ latitude: boundary, longitude: BAKU.longitude });
      const below = snapToSearchCell({ latitude: boundary - 1e-9, longitude: BAKU.longitude });

      expect(on.row).toBe(8_075);
      expect(below.row).toBe(8_074);
      expect(on.centre.latitude).not.toBe(below.centre.latitude);
    });

    it('splits a column boundary the same way', () => {
      const { row } = snapToSearchCell(BAKU);
      const columnDegrees = searchCellColumnDegrees(row);
      const edge = 7_587 * columnDegrees;
      const on = snapToSearchCell({ latitude: BAKU.latitude, longitude: edge });
      const west = snapToSearchCell({ latitude: BAKU.latitude, longitude: edge - 1e-9 });

      expect(on.column).toBe(7_587);
      expect(west.column).toBe(7_586);
    });

    it('floors towards −∞ at a negative longitude, so cells on either side of 0° do not merge', () => {
      const west = snapToSearchCell({ latitude: 51.5, longitude: -0.001 });
      const east = snapToSearchCell({ latitude: 51.5, longitude: 0.001 });

      expect(west.column).toBe(-1);
      expect(east.column).toBe(0);
      expect(west.centre.longitude).toBeLessThan(0);
      expect(east.centre.longitude).toBeGreaterThan(0);
    });

    it('gives every point inside one cell the same centre', () => {
      const first = snapToSearchCell({ latitude: 40.3726, longitude: 49.8427 });
      const second = snapToSearchCell({ latitude: 40.3741, longitude: 49.8441 });

      expect(second).toEqual(first);
    });
  });

  describe('coarsenSearchCells', () => {
    it('collapses masters in one cell into one point', () => {
      const cells = coarsenSearchCells(
        [
          { latitude: 40.3726, longitude: 49.8427 },
          { latitude: 40.3741, longitude: 49.8441 },
          { latitude: 40.39, longitude: 49.87 },
        ],
        BAKU,
      );

      expect(cells).toHaveLength(2);
    });

    it('returns nothing but cell centres', () => {
      const positions = Array.from({ length: 30 }, (_, index) => ({
        latitude: 40.33 + index * 0.0031,
        longitude: 49.8 + index * 0.0047,
      }));

      for (const cell of coarsenSearchCells(positions, BAKU, 100)) {
        expect(cell).toEqual(snapToSearchCell(cell).centre);
        expect(positions).not.toContainEqual(cell);
      }
    });

    it('orders nearest the address first, and the same whatever order the positions came in', () => {
      const near = { latitude: BAKU.latitude + 0.001, longitude: BAKU.longitude };
      const middle = { latitude: BAKU.latitude + 0.02, longitude: BAKU.longitude };
      const far = { latitude: BAKU.latitude + 0.05, longitude: BAKU.longitude };

      const forwards = coarsenSearchCells([far, near, middle], BAKU);
      const backwards = coarsenSearchCells([middle, near, far], BAKU);

      expect(forwards).toEqual(backwards);
      expect(forwards[0]).toEqual(snapToSearchCell(near).centre);
      expect(forwards[2]).toEqual(snapToSearchCell(far).centre);
    });

    it(`caps the result at ${String(SEARCH_CELL_LIMIT)}, keeping the nearest`, () => {
      const positions = Array.from({ length: 20 }, (_, index) => ({
        latitude: BAKU.latitude + (index + 1) * SEARCH_CELL_ROW_DEGREES,
        longitude: BAKU.longitude,
      }));

      const cells = coarsenSearchCells(positions, BAKU);

      expect(cells).toHaveLength(SEARCH_CELL_LIMIT);
      expect(cells.at(-1)).toEqual(
        snapToSearchCell(positions[SEARCH_CELL_LIMIT - 1] ?? BAKU).centre,
      );
    });

    it('draws nothing when nobody has a fresh position', () => {
      expect(coarsenSearchCells([], BAKU)).toEqual([]);
    });
  });
});
