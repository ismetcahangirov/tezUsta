/**
 * Stable, machine-readable error codes returned in every API error envelope
 * (see `docs/architecture/backend-architecture.md` § Error model). Declared
 * as a `const` object + derived union so a client can `switch` on a value the
 * compiler knows, rather than a loose string.
 *
 * This union lives here today and moves to `packages/types` the moment
 * `apps/mobile` consumes the API directly — one definition either way, never
 * two (ADR-0016).
 *
 * Seeded with what issue #19 (API scaffold) actually needs: the one
 * unexpected-error fallback, the one validation-failure code, and the generic
 * codes for the HTTP statuses the global filter already has to map per the
 * doc's status table (400/401/403/404/409/422/429/500). None of these are
 * business-domain codes — order/payment-specific codes (e.g.
 * `ORDER_ALREADY_TAKEN`) belong to the Epics that introduce those errors.
 */
export const ERROR_CODES = {
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
