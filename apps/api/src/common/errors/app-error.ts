import type { ErrorCode } from './error-codes.types';

/**
 * Base class for every domain error thrown from a service. Carries exactly
 * what the global exception filter needs to build the error envelope: a
 * stable code, the HTTP status to answer with, a message that is safe to
 * show a user, and optional details that must never contain anything
 * sensitive (no SQL, no stack, no PII — `docs/engineering/security.md`).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;

    // `exactOptionalPropertyTypes` rejects assigning `undefined` to an
    // optional property explicitly, so `details` is only ever set when a
    // caller actually provided one.
    if (details !== undefined) {
      this.details = details;
    }

    Object.setPrototypeOf(this, AppError.prototype);
  }
}
