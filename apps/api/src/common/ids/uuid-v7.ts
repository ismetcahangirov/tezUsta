import { randomBytes } from 'node:crypto';

/**
 * Generates a UUIDv7 (RFC 9562 §5.7): a 48-bit big-endian Unix timestamp in
 * milliseconds, followed by 74 bits of CSPRNG randomness, with the version and
 * variant bits overwritten in place.
 *
 * `docs/architecture/database-architecture.md` § Conventions asks for v7
 * primary keys — "time-ordered, so it indexes well". That property is not
 * cosmetic: a v4 key is uniformly random, so every insert lands on a random
 * B-tree leaf and the index's hot set becomes the whole index. A v7 key is
 * monotonic at millisecond resolution, so inserts append to the right-hand
 * edge and the working set stays small.
 *
 * Written here rather than taken from a package (CLAUDE.md §10 — "is it
 * actually necessary, or is this a few lines of our own code?"): the whole
 * specification is the six lines below, and `node:crypto` already supplies the
 * only part that matters, the CSPRNG. Postgres cannot supply it either —
 * `gen_random_uuid()` is v4 and PostgreSQL 17 has no v7 function (v18 adds
 * `uuidv7()`), which is why every table's id is generated application-side and
 * no column carries a database default. One generator, not two.
 *
 * `now` is a parameter only so a test can pin the timestamp; production always
 * takes the default.
 */
export function uuidV7(now: number = Date.now()): string {
  // 16 random bytes first, then the timestamp and the two fixed bit-fields
  // written over them — so every bit that is not spoken for by the spec is
  // CSPRNG output, and `Math.random()` never enters this file.
  const bytes = randomBytes(16);

  // Bytes 0-5: unix_ts_ms, 48 bits, big-endian. `writeUIntBE` accepts at most
  // 6 bytes, which is exactly the field width.
  bytes.writeUIntBE(now, 0, 6);

  // Byte 6 high nibble: version 7. Byte 8 high two bits: variant 0b10.
  // Read-modify-write via the typed accessors rather than `bytes[6]`, which
  // `noUncheckedIndexedAccess` types as possibly undefined.
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
