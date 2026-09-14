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
Button/
  Button.tsx
  Button.test.tsx      # co-located

orders/
  orders.service.ts
  orders.service.test.ts
  orders.integration.test.ts
```

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
install → format:check → lint → typecheck → test → build → graph:validate
```

- Integration tests run against a real Postgres+PostGIS service container.
- **A failing test is never skipped to land a change.** Deleting or skipping a
  test to make CI green is forbidden ([CLAUDE.md §19](../../CLAUDE.md)).
- A flaky test is a bug. Fix it or remove it — never retry it into passing.

## Definition of Done

`pnpm test` **executed and passing**, not assumed ([CLAUDE.md §8](../../CLAUDE.md)).
Claiming a task is done without running the tests is a forbidden behaviour.
