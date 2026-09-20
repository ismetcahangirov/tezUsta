import type { SQL, SQLWrapper } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

/**
 * When an order last entered `SEARCHING`, to the millisecond — the fact the
 * whole dispatch schedule is derived from (issue #103).
 *
 * **Read from the audit trail rather than kept as a column on `orders`.** The
 * trail already records it, exactly once per search and including every
 * re-dispatch (ADR-0015), so a `searching_since` column would be a second copy
 * of a fact that is already written down — one that a future transition could
 * forget to update, leaving an order whose search started at a time nothing
 * else agrees with. `order_status_history_order_idx` is `(order_id,
 * created_at)`, so this reads one order's own trail and nothing else.
 *
 * It doubles as the search's **generation**: a re-dispatch produces a new
 * value, so a tick left over from the previous search can recognise that it
 * does not belong to this one and exit without touching anything.
 *
 * **It is epoch milliseconds, not a timestamp, and that is load-bearing.**
 * Postgres stores `timestamptz` to the microsecond while a JavaScript `Date`
 * holds milliseconds, so a value read out and compared back in would never
 * equal itself — the guard depending on it would silently never match, which
 * is the worst possible failure for a guard. Worse still, `db.execute` does
 * not hand back a `Date` at all: `drizzle-orm`'s node-postgres driver replaces
 * pg's timestamp parsers so its own column mappers can do the conversion, and
 * raw SQL therefore yields Postgres's text form. Reducing both sides to an
 * integer on the database side removes the whole class of problem: one
 * representation, produced by one expression, compared as a number.
 *
 * `bigint` crosses the wire as a string (pg does not narrow a 64-bit integer
 * to a `number` on its own), so callers read it through `Number`. Epoch
 * milliseconds are far inside `Number.MAX_SAFE_INTEGER`.
 *
 * **Its own file rather than a second export from `orders.repository.ts`**,
 * because `order-offers.repository.ts` needs the same expression for the
 * generation term in its broadcast guard, and `orders.repository.ts` already
 * imports `OrderOffersRepository` — importing it back would be a cycle, and
 * `no-circular` fails the build on one (CLAUDE.md §14).
 */
export function searchingSinceOf(orderIdColumn: SQL | SQLWrapper): SQL {
  return sql`(
    select (extract(epoch from date_trunc('milliseconds', max(h.created_at))) * 1000)::bigint
      from order_status_history h
     where h.order_id = ${orderIdColumn}
       and h.to_status = 'SEARCHING'
  )`;
}
