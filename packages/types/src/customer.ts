/**
 * A customer profile as the API returns it.
 *
 * **This is the role profile, not the account.** Identity — the phone number
 * the person signs in with, their account status, the roles they hold — lives
 * on `users` and is deliberately absent here
 * (`docs/product/user-roles.md` § Roles are a set, not a single field). One
 * person may be both a customer and a master on one account; they have one
 * phone number and two profiles, and neither profile restates the phone
 * number.
 *
 * `userId` is absent for the same reason a phone number is: nothing a client
 * does needs it. A customer addresses their own profile as `/customers/me`,
 * and every other read is ownership-checked server-side against the caller's
 * actor. Putting the account id on the wire would hand clients a second
 * identifier for the same person, and the first place it would show up is a
 * request body the server then has to distrust.
 */
export interface Customer {
  readonly id: string;
  readonly displayName: string;
  /**
   * Object-storage key for the avatar, or `null` while there is none.
   *
   * A **key**, not a URL, and never client-supplied. The bucket is private
   * ([ADR-0005](docs/decisions/ADR-0005-object-storage.md)), so a client turns
   * this into something it can render by asking for a short-lived presigned
   * GET — a URL embedded here would either be permanent (and therefore a
   * public bucket) or stale by the time it was used.
   *
   * It is always `null` today: the upload flow that would set it needs the
   * storage provider ADR-0005 leaves open. The field exists now so the shape
   * a client renders against does not change when it lands.
   */
  readonly avatarKey: string | null;
  /** ISO 8601, UTC. */
  readonly createdAt: string;
  /** ISO 8601, UTC. */
  readonly updatedAt: string;
}
