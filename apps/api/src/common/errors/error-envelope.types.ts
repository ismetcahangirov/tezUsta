import type { ErrorCode } from './error-codes.types';

/**
 * The one error shape returned by every endpoint, per
 * `docs/architecture/backend-architecture.md` § Error model.
 */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}
