/** Any RFC 9562 UUID, case-insensitive — the shape every id the API takes has. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value`, trimmed, is a UUID. A filter field checks this before a round-trip. */
export function isUuid(value: string): boolean {
  return UUID.test(value.trim());
}

/** The first block of an id — enough to tell rows apart in a dense table. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
