import { NotFoundError } from '../errors/not-found.error';

/**
 * The ownership check every resource handler makes before it returns a row:
 * "does this exist, and may this caller see it?" — answered as one operation
 * with one outcome.
 *
 * ```ts
 * const order = requireVisibleOrNotFound(
 *   await this.orders.findById(id),
 *   (candidate) => candidate.customerId === actor.userId,
 * );
 * ```
 *
 * **Being authenticated is not being entitled**
 * (`docs/architecture/authentication.md` § Server ownership checks). A guard
 * proves who the caller is; nothing about a valid token entitles its holder to
 * an arbitrary id, and the omitted ownership check is the single most common
 * real vulnerability in a marketplace API.
 *
 * The name says `OrNotFound` because the 404 is the load-bearing part and a
 * reader has to meet it at the call site rather than discover it later in a
 * stack trace: "not yours" and "does not exist" must be indistinguishable to
 * the caller, or the endpoint becomes an existence oracle (see
 * {@link NotFoundError}). Handing both cases to one function is what makes that
 * structural — a handler that wrote `if (!order) throw new NotFoundError(); if
 * (!mine) throw new ForbiddenError();` would be two correct-looking lines that
 * together leak.
 *
 * Takes a **predicate rather than an owner id** because ownership is rarely one
 * column: an order is visible to its customer, to its assigned master, and to
 * an admin (`docs/product/user-roles.md` § Capability matrix), and a signature
 * that only compared one id would push those handlers back onto hand-rolled
 * checks — which is where the guarantee goes to die.
 *
 * The predicate runs only when the resource exists, so it may assume a
 * non-null value and never has to repeat the null check.
 */
export function requireVisibleOrNotFound<T>(
  resource: T | null | undefined,
  isVisibleToActor: (resource: T) => boolean,
): T {
  if (resource === null || resource === undefined) {
    throw new NotFoundError();
  }
  if (!isVisibleToActor(resource)) {
    throw new NotFoundError();
  }
  return resource;
}
