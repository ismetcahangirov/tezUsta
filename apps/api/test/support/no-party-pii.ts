import { expect } from 'vitest';

/**
 * Asserts that what a party to an order is shown carries neither party's
 * phone number or account id, and no key that names a phone or a token
 * (#428).
 *
 * The parties are found from the order itself — its customer and its
 * assigned master, through `customers` and `masters` to `users` — so a suite
 * needs only the order id it already has, and the assertion cannot be fooled
 * by a fixture that formats a number differently from what is stored. Both
 * spellings of each number are checked, with and without the `+`.
 *
 * The shape of `call-records.e2e`'s `expectNoPii`, shared, for every surface a
 * message travels through: HTTP, the socket and the push.
 */
export async function expectNoPartyPii(
  pool: {
    query: <R>(text: string, values: unknown[]) => Promise<{ rows: R[] }>;
  },
  shown: unknown,
  orderId: string,
): Promise<void> {
  const { rows } = await pool.query<{ id: string; phone_e164: string }>(
    `select u.id::text as id, u.phone_e164
       from orders o
       join customers c on c.id = o.customer_id
       join users u on u.id = c.user_id
      where o.id = $1
     union all
     select u.id::text as id, u.phone_e164
       from orders o
       join masters m on m.id = o.master_id
       join users u on u.id = m.user_id
      where o.id = $1`,
    [orderId],
  );
  // A positive control: "no phone" means nothing unless both phones it looks
  // for were found.
  expect(rows).toHaveLength(2);

  const text = JSON.stringify(shown);
  for (const row of rows) {
    expect(text).not.toContain(row.phone_e164);
    expect(text).not.toContain(row.phone_e164.slice(1));
    expect(text).not.toContain(row.id);
  }
  expect(text).not.toMatch(/"[^"]*(phone|token)[^"]*"\s*:/i);
}
