# ADR-0028 — A customer profile is created by a first-run question, not by a server-side placeholder

- **Status:** **Accepted** (the wider first-run experience pending — see _What this does not decide_)
- **Date:** 2026-09-20
- **Amends:** [`customer-flow.md`](../product/customer-flow.md) § Sign in, which
  described sign-in as "one step: enter the number, enter the code, signed in"
  and named no profile-creation step at all.

## Context

Sign-in is **phone + SMS OTP only** ([ADR-0008](ADR-0008-otp-delivery.md)). It
proves a number and creates a `users` row with `roles: []`. It carries no name,
because an SMS code cannot.

Every customer-scoped service begins with `CustomersService.getOwn(actor)`,
which throws `NotFoundError` when the caller has no row in `customers` — and
that row is created only by `POST /customers`, which requires a `displayName`.
The API is right to do this: the same 404 is what stops `GET /addresses/:id`
confirming that a stranger's row exists.

**Nothing in `apps/mobile` called `POST /customers`.** A grep across the app
returned no reference to `/customers` at all. So a real user signed in with a
phone and a code, landed in the customer group, and every customer-scoped
request answered 404: saved addresses, order creation, order reads, photos. The
customer half of EPIC 6 was unusable on a device, and issue
[#94](https://github.com/ismetcahangirov/tezUsta/issues/94) recorded it as
needing a decision rather than a patch, because three routes were open and they
are not equivalent.

## Decision

**A first-run step asks for a name.** On entering the customer area, the app
reads `GET /customers/me`; a 404 — and only a 404 — renders one screen with one
field, whose submit is `POST /customers`. A returning customer never sees it.

Specifically:

1. **`displayName` stays required.** The API contract is unchanged. No new
   endpoint, no new column, no server change of any kind was needed for this.
2. **The gate is per-role**, mounted in `app/(customer)/_layout.tsx`. A master
   never meets it.
3. **It renders, it does not redirect.** The question is the condition of
   entering the customer area, not a destination — so there is no route to push,
   nothing to deep-link into, and no redirect racing the auth guard.
4. **A 404 is an answer; every other failure is not.** `customerProfileState`
   separates `missing` from `unavailable`, and a 5xx or a dead network produces
   "try again", never the name question.
5. **Idempotent under retry**, which costs nothing because the server already
   is: `POST /customers` answers 201 when it created the row and 200 when an
   earlier identical call had, by `ON CONFLICT` on `customers_user_id_unique`.
   A retried create is not an error the client reports.

## Why

**Because a name is not paperwork here — it is what the master is shown.** The
master who accepts the job and travels to somebody's home sees the customer on
the order. That is the product reason the field exists, and it is the reason the
two alternatives both fail: neither produces a name anyone chose.

**Alternative 1 — make `displayName` optional, name yourself later.** Rejected.
It changes the API contract to remove a requirement the product has, and it does
not remove the question, only defers it to a moment nobody has designed. In the
meantime every master sees an unnamed customer on an order card, which is worse
for the master than a short question is for the customer. "Later" also has a way
of never arriving: nothing in the product would ever force it.

**Alternative 2 — the server creates a profile with a placeholder at first
sign-in.** Rejected, and it is the most tempting of the three because it needs
no screen. Two objections, either sufficient:

- It writes a **product statement** into the sign-in path: that every
  authenticated user is a customer. [`user-roles.md`](../product/user-roles.md)
  says a role is a set and one person may hold both; sign-up deliberately grants
  no role at all, and the role is chosen afterwards by creating a profile. A
  master who signs in to work would silently become a customer too.
- The placeholder is seen. `Müştəri`, or a masked phone number, is what the
  master reads on the order card — a name nobody chose, presented as one.

**Why the 404/failure distinction is load-bearing rather than fussy.** The
naive gate treats "the profile request did not succeed" as "there is no
profile". That asks a customer of two years to introduce themselves every time
their train enters a tunnel, and then posts a create they did not need. The two
states are kept apart in a pure function with its own tests, because the failure
is invisible on the happy path and permanent once shipped.

## What this does not decide

**The onboarding flow.** CLAUDE.md §17 reserves "what a first-run user is shown,
and in what order" to the owner, and this ADR does not claim it. What is decided
here is narrower and was forced by the API: the one question `POST /customers`
cannot proceed without, asked once. There is no welcome sequence, no artwork, no
role chooser, no tour, and no second field — every one of those is still the
owner's, and adding one is not a follow-up this ADR authorises.

**The screen's words.** `customers-copy.ts` carries placeholders under the same
rule `addresses-copy.ts` states: the _content_ of a first-run screen is the
owner's, and the strings there are the plainest factual Azerbaijani that makes
the step usable until the real copy is decided.

**Where a customer changes their name afterwards.** `PATCH /customers/me`
exists; no screen calls it yet. That belongs with the profile screen, which is
not this issue.

## Trade-offs accepted

- **One extra request on entering the customer area**, cached for 30 seconds by
  the api slice's `refetchOnMountOrArgChange` and shared by every screen in the
  group. It is one indexed read on a unique index.
- **A customer who dismisses the app on the question is asked again next
  launch.** That is correct — there is no profile, so there is nothing else the
  app could show — but it does mean the step cannot be skipped. If the owner
  later wants it skippable, that is an onboarding decision, and skipping it
  leaves the customer surfaces 404ing exactly as before.
- **A soft-deleted profile looks like a missing one.** `getOwn` filters
  `deleted_at IS NULL`, so a customer who deleted their profile is asked the
  question again, and `createOrRevive` brings the original row back with its
  history rather than starting a second one. That is the intended behaviour of
  the revive path, reached through this screen.

## Consequences

- `apps/mobile/src/customers/` exists: the endpoints, the gate, the screen and
  the state function, with `'Customer'` added to the api slice's `tagTypes`.
- `app/(customer)/_layout.tsx` wraps its stack in the gate. `route-guard.ts` is
  untouched — it still decides which _group_ a user belongs in, and this decides
  what that group can show once they are in it.
- [`customer-flow.md`](../product/customer-flow.md) § Sign in now names the step.
- CLAUDE.md §17's onboarding entry stops saying that nothing on a device can
  create a customer profile, and says instead what has been settled and what has
  not.
