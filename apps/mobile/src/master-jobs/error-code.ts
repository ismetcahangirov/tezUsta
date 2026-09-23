/**
 * The server's stable error code out of an RTK Query error, or `undefined`.
 *
 * The envelope is `{ error: { code, message, details? } }`
 * (`docs/architecture/backend-architecture.md` § Error model). Read
 * defensively, because a transport failure has no body at all and a proxy's
 * 502 has one that is not ours.
 */
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('data' in error)) {
    return undefined;
  }
  const body = (error as { data?: unknown }).data;
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return undefined;
  }
  const code = (body as { error?: { code?: unknown } }).error?.code;
  return typeof code === 'string' ? code : undefined;
}
