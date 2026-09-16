import { describe, expect, it } from 'vitest';

import { uuidV7 } from './uuid-v7';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('uuidV7', () => {
  it('produces the canonical 8-4-4-4-12 hex form', () => {
    expect(uuidV7()).toMatch(UUID_SHAPE);
  });

  it('sets the version nibble to 7 (RFC 9562 §5.7)', () => {
    const id = uuidV7();
    // The version lives in the high nibble of the 7th byte, which is the
    // first character of the third group.
    const versionNibble = id.split('-')[2]?.[0];
    expect(versionNibble).toBe('7');
  });

  it('sets the variant bits to 0b10 (RFC 9562 §4)', () => {
    const id = uuidV7();
    // The variant lives in the high two bits of the 9th byte, the first
    // character of the fourth group — any of 8, 9, a, b satisfies 0b10xx.
    const variantNibble = id.split('-')[3]?.[0];
    expect(['8', '9', 'a', 'b']).toContain(variantNibble);
  });

  it('encodes the millisecond timestamp passed in across the first 48 bits', () => {
    const fixedMs = Date.UTC(2026, 8, 16, 12, 0, 0);
    const id = uuidV7(fixedMs);

    const hex = id.replace(/-/g, '');
    const timestampHex = hex.slice(0, 12); // 48 bits = 6 bytes = 12 hex chars
    expect(Number.parseInt(timestampHex, 16)).toBe(fixedMs);
  });

  it('sorts lexicographically the same way its timestamps sort numerically', () => {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    const timestamps = [base, base + 1, base + 1000, base + 60_000, base + 86_400_000];
    const ids = timestamps.map((ms) => uuidV7(ms));

    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it('generates no duplicate across a large batch', () => {
    const batch = 10_000;
    const ids = new Set<string>();
    for (let i = 0; i < batch; i += 1) {
      ids.add(uuidV7());
    }
    expect(ids.size).toBe(batch);
  });
});
