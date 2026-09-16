import { AppError } from './app-error';
import { ERROR_CODES } from './error-codes.types';

/**
 * The one 404 the API answers with — for a row that does not exist **and** for
 * a row the caller may not see. Deliberately the same error object for both,
 * not two that happen to share a status.
 *
 * `docs/architecture/backend-architecture.md` § Error model makes 404 mean
 * "Not found, **or** not visible to this caller", because a 403 on someone
 * else's order id confirms that the order exists and turns every `GET
 * /orders/:id` into an existence oracle: an attacker walks ids and learns the
 * platform's order volume, and on a marketplace that is commercially sensitive
 * before it is anything else.
 *
 * That guarantee is about the bytes on the wire, not the intent. It survives
 * only while the two cases are indistinguishable in every field — code,
 * message, and the absence of `details` — which is why this class takes no
 * arguments at all. Adding `details: { orderId }` to one call site would
 * reinstate the oracle without changing a single status code.
 */
export class NotFoundError extends AppError {
  constructor() {
    super(ERROR_CODES.NOT_FOUND, 'Not found.', 404);
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}
