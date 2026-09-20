/**
 * Safe reads over an RTK Query mutation's `error`, mirroring the defensive
 * parsing `master-availability`'s `verificationStatusFrom` uses: the shape
 * comes from the network, so nothing here casts, and every accessor answers
 * `undefined` rather than throwing when the shape does not match.
 *
 * The envelope itself is `apps/api/src/common/errors/error-envelope.types.ts`,
 * transcribed rather than imported: `apps/mobile` may not import `apps/api`
 * (CLAUDE.md §14), and the shape is small enough that re-typing it here is
 * the whole cost.
 */

interface ErrorIssue {
  readonly path: string;
  readonly message: string;
}

interface ErrorEnvelopeBody {
  readonly code: string;
  readonly message: string;
  readonly details?: { readonly issues?: readonly ErrorIssue[] };
  readonly requestId: string;
}

/** The HTTP status, when the failure reached the server and got one back. */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** The server's own error envelope, when the response body carried one. */
export function envelopeOf(error: unknown): ErrorEnvelopeBody | undefined {
  if (typeof error !== 'object' || error === null || !('data' in error)) {
    return undefined;
  }
  const body = (error as { data?: unknown }).data;
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return undefined;
  }
  const envelope = (body as { error?: unknown }).error;
  return typeof envelope === 'object' && envelope !== null
    ? (envelope as ErrorEnvelopeBody)
    : undefined;
}

/**
 * A 422's per-field issues, keyed by the field path the server named — the
 * same names `addresses.schema.ts` validates (`formattedAddress`, `building`,
 * `entrance`, `floor`, `apartment`, `landmarkNote`, `label`), so a caller can
 * hand one straight to the matching `TextField`'s `error` prop.
 */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  const issues = envelopeOf(error)?.details?.issues;
  if (!Array.isArray(issues)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const issue of issues) {
    if (
      typeof issue === 'object' &&
      issue !== null &&
      typeof (issue as ErrorIssue).path === 'string' &&
      typeof (issue as ErrorIssue).message === 'string'
    ) {
      result[(issue as ErrorIssue).path] = (issue as ErrorIssue).message;
    }
  }
  return result;
}
