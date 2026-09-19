# Testing strategy

## The principle

**Tests verify behaviour, not implementation.**

```ts
// Bad — asserts internals; breaks on any refactor, proves nothing about the user
expect(component.state.isAccepting).toBe(true);
expect(service.repository.update).toHaveBeenCalledWith(...);

// Good — asserts what a person observes
await user.press(screen.getByRole('button', { name: 'Accept' }));
expect(await screen.findByText('On the way')).toBeVisible();
```

A test coupled to implementation fails when the code is improved and passes when
the behaviour breaks. That is worse than no test, because it is trusted.

## Tooling

| Layer                      | Tool                                        | Why                                                                                 |
| -------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| Mobile unit / component    | Jest + `@testing-library/react-native`      | `jest-expo` is maintained by Expo and configures the RN transform correctly         |
| Backend unit + integration | Vitest                                      | Fast, native ESM, simple config; no RN constraint here                              |
| HTTP integration           | Supertest                                   | Real requests through the real Nest pipeline                                        |
| Database integration       | Disposable Postgres + **PostGIS** container | Mocking the database would not test the spatial queries, which is where the risk is |
| E2E                        | **Maestro**                                 | Expo's documented E2E path for EAS Workflows                                        |

Two runners in one monorepo is a real cost, accepted because each is clearly
better in its half. Rationale:
[`../architecture/technology-stack.md`](../architecture/technology-stack.md) §9.

## What must be tested

### The order state machine — exhaustively

The complete status set and the only legal edges are
[ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md):

```
DRAFT  SEARCHING  ACCEPTED  MASTER_ON_THE_WAY  MASTER_ARRIVED  IN_PROGRESS
COMPLETED  PAYMENT_PENDING  PAID  DISPUTED  RESOLVED  REFUNDED
NO_MASTER_FOUND  CANCELLED
```

**Every valid transition, and every invalid one.** A state machine tested only on
its happy path is not tested.

```ts
it('rejects IN_PROGRESS → SEARCHING', async () => {
  const order = await seedOrder({ status: 'IN_PROGRESS' });
  await expect(orders.transition(order.id, 'SEARCHING', actor)).rejects.toThrow(
    InvalidTransitionError,
  );
});
```

Four properties of the table need tests of their own, because each one is a rule
a plain edge-by-edge sweep would miss:

- **Re-dispatch.** `ACCEPTED`, `MASTER_ON_THE_WAY` and `MASTER_ARRIVED` return to
  `SEARCHING` when the assigned master cancels. Assert that the transaction
  clears `master_id` **and** `price_minor` together, increments
  `redispatch_count`, and excludes the cancelling master from the next
  broadcast — and that at `MAX_ORDER_REDISPATCHES` the order goes to
  `NO_MASTER_FOUND` instead of searching again.
- **`NO_MASTER_FOUND` is not `CANCELLED`.** A timed-out order must never be
  counted as a cancellation; cancellation rate is a quality signal and an
  unfilled order is a supply signal. Assert the status, not just that the order
  ended.
- **`DISPUTED` is not terminal.** `RESOLVED` and `REFUNDED` both require an admin
  actor and a mandatory reason. Test the missing-reason case.
- **An admin override bypasses the actor check, never the edge table.** An admin
  may make a transition the table permits while being neither the customer nor
  the assigned master; an admin attempting an edge the table does not contain
  must be rejected exactly like anyone else. Both cases need a test, and every
  override writes `order_status_history` with actor and reason.

### Concurrent accept — with real concurrency

The most important test in the system. It must issue genuinely parallel
requests; sequential calls do not exercise the race the guard exists to prevent.

```ts
it('lets exactly one master win a concurrent accept', async () => {
  const order = await seedOrder({ status: 'SEARCHING' });
  const results = await Promise.allSettled(masters.map((m) => api.acceptOrder(order.id, m)));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
});
```

The price is frozen in that same transaction
([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)): `price_minor` is
**null while `SEARCHING`** and is written together with `master_id` by the
winning accept. So the concurrency test also asserts that the surviving order
carries the **winner's** price, and a separate test asserts that a losing
master's price never lands on the order. A later edit to that master's profile
price must not move the frozen value — the freeze is a copy, not a reference.

### Authorization — the negative cases

For every endpoint:

- unauthenticated → 401
- wrong role → 403
- **another user's resource → 404** (not 403 — a 403 confirms existence)
- suspended master cannot accept, **even with a token issued before suspension**

Authorization tests that only cover the permitted case prove nothing.

### Spatial queries — against real PostGIS

`ST_DWithin` and GiST index behaviour cannot be mocked. These run against a real
container, and they assert both correctness (the right masters) and that the
query plan uses the index.

### Validation

Every endpoint: missing fields, wrong types, out-of-range values, unknown fields,
oversized payloads.

### Components

Every reusable component has a co-located test covering: renders with required
props, responds to interaction, and shows its loading/empty/error states.

## What not to test

- **Blanket snapshot tests.** A snapshot nobody reads is a rubber stamp that
  fails on every unrelated change until someone updates it reflexively.
- Third-party library behaviour.
- Trivial getters, or types the compiler already guarantees.
- Private methods — test them through the public surface.

## Structure

```
apps/mobile/src/components/
  Button.tsx
  Button.test.tsx        # co-located, always
  Button.stories.tsx     # reviewed in Storybook before the component is wired into a screen
  index.ts               # one shared barrel for the whole directory

apps/api/src/modules/orders/
  orders.service.ts
  orders.service.test.ts
  orders.integration.test.ts
```

Components are **flat files in one directory**, not a directory per component —
that is what the repository does today, and a new component follows it rather
than introducing a second layout beside it.

Co-location keeps the test visible next to the code, so it is updated rather than
forgotten.

**Test names state the behaviour**, not the method:

```ts
// Bad
it('calls acceptOrder');
// Good
it('rejects an accept when the master is not verified');
```

## Test data

- Use factories with sensible defaults; each test overrides only what it cares
  about. A test that sets fifteen fields obscures which one matters.
- Every test seeds its own data and cleans up. Order-dependent tests are flaky
  tests.
- Never share mutable state between tests.

## Teardown

**Nothing a test scheduled may still be scheduled when the test is over.** A
timer left running fires into an environment Jest has already torn down, and a
long one holds the worker's event loop open until Jest force-exits it. Neither
fails on its own, which is what makes them expensive: the leaked work
accumulates and eventually pushes some unrelated `waitFor` past its deadline, on
whichever pull request happens to be running on a contended CI worker
([#96](https://github.com/ismetcahangirov/tezUsta/issues/96)).

In `apps/mobile` this is handled once, in `test/setup-teardown.ts`, which after
every test unmounts, disposes of what the test registered, and clears any timer
still outstanding. One rule follows from it:

- **Make a store with `createTestStore()`** (`test/support/test-store.ts`), never
  `createAppStore()`. An RTK Query store keeps requests in flight, a
  cache-collection timer per unsubscribed entry, and a polling schedule; the app
  has one store for the life of the process, a test throws one away every few
  hundred milliseconds. `createTestStore` enrols it for `resetApiState()` at the
  end of the test, which is RTK Query's own disposal.

Anything else that outlives a test registers its own undo with `onTestEnd()`
rather than adding a second teardown mechanism beside this one.

## Mocking

- **Mock at the boundary** — the HTTP transport, the SMS provider, the maps
  provider. Not internal modules.
- **Do not mock the database** in integration tests. Use a real container; a
  mocked database tests the mock.
- Mocking a module you own usually means the seam is wrong. Consider injecting
  a dependency instead.

## Coverage

Coverage is a **diagnostic, not a target**. A percentage goal produces tests
written to raise a number.

Instead: every bug fix ships with a test that fails without the fix. That is the
coverage that matters.

`node tools/project-graph/query.mjs --untested apps/api` lists files no test
imports. Note the limit: it shows which files a test _touches_, not which lines
it exercises. Use it to find untested files; use the coverage report for detail.

## E2E scope

Maestro covers a small number of critical journeys only:

1. Customer creates an order → master accepts → completion
2. Sign-in
3. Master goes online and receives an offer

E2E tests are slow and brittle. Cover the journey; put fine-grained assertions in
unit and integration tests.

## CI

```
install → format:check → lint → typecheck → test → build → graph:validate → graph:check
```

- Integration tests run against a real Postgres+PostGIS service container.
- `graph:check` regenerates the project graph and fails on a non-empty diff. The
  generator reads no clock and sorts every collection, so a diff means the source
  tree moved, not that the file was rewritten.
- **A failing test is never skipped to land a change.** Deleting or skipping a
  test to make CI green is forbidden ([CLAUDE.md §19](../../CLAUDE.md)).
- A flaky test is a bug. Fix it or remove it — never retry it into passing.

### What `pnpm test` actually runs today

`apps/mobile` is the only workspace with a `test` script, and it runs
`jest --passWithNoTests`. That flag is a **scaffold allowance for a tree where
`apps/api` does not exist yet** — without it, `turbo run test` fails on a
workspace that has legitimately written none.

It sits in obvious tension with the rule directly above, because a flag that
tolerates zero tests also tolerates a suite that silently stopped being
collected. So: **remove `--passWithNoTests` as soon as a workspace has tests it
could lose.** Until then it is a known, bounded exception, not a precedent.

`pnpm build` is in the chain and is a **no-op today** — no workspace defines a
`build` script. It becomes a real gate when `apps/api` lands. A green CI run is
therefore not evidence that anything built.

## Definition of Done

`pnpm test` **executed and passing**, not assumed ([CLAUDE.md §8](../../CLAUDE.md)).
Claiming a task is done without running the tests is a forbidden behaviour.
