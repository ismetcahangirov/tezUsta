import type { SerializedError } from '@reduxjs/toolkit';
import type { FetchBaseQueryError } from '@reduxjs/toolkit/query';

/**
 * What the panel needs to know about a failed request: the HTTP status, and
 * the stable `error.code` from the API's error envelope
 * (docs/architecture/backend-architecture.md § Error model) when there is one.
 * The envelope's `message` is deliberately not surfaced — the panel shows its
 * own copy, keyed by code.
 */
export interface ApiFailure {
  readonly status: number | 'network';
  readonly code: string | undefined;
}

function envelopeCode(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || !('error' in data)) return undefined;
  const { error } = data;
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export function describeFailure(
  error: FetchBaseQueryError | SerializedError | undefined,
): ApiFailure | undefined {
  if (error === undefined) return undefined;
  if (!('status' in error)) return { status: 'network', code: undefined };
  if (typeof error.status === 'number') {
    return { status: error.status, code: envelopeCode(error.data) };
  }
  if (error.status === 'PARSING_ERROR') {
    return { status: error.originalStatus, code: undefined };
  }
  return { status: 'network', code: undefined };
}
