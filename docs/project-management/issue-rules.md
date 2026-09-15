# Issue rules

## The test for a good issue

**Could someone who was not in the conversation complete this, and know when
they were finished?**

If not, it is a note, not an issue.

## Templates

### Implementation issue

```markdown
## Objective

One sentence. What this achieves.

## Context

Why now. What it depends on. Links to docs/ and ADRs that apply.

## Requirements

- [ ] Specific and checkable
- [ ] Each one independently verifiable

## Technical considerations

Constraints, gotchas, and prior decisions that bear on this.

## Acceptance criteria

- [ ] Observable outcomes — what is true when this is done
- [ ] Behaviour, not implementation

## Testing requirements

- [ ] Happy path
- [ ] Failure cases
- [ ] Authorization / negative cases
- [ ] Concurrency, where relevant

## Dependencies

Blocked by #N. Blocks #M.

## Definition of Done

Per CLAUDE.md §8.
```

### Epic

```markdown
## Problem

What is wrong or missing today.

## Goal

What is true when this Epic is complete.

## Scope

What is included.

## Out of scope

What is deliberately excluded — and where it went instead.

## Technical considerations

## Dependencies

## Acceptance criteria

## Definition of Done
```

**Out of scope is not optional.** It is what stops an Epic absorbing adjacent
work until it never finishes.

## Requirements vs acceptance criteria

They are different, and conflating them makes an issue unverifiable.

- **Requirements** — what to build. _"Add `POST /orders`."_
- **Acceptance criteria** — how you know it works, observably.
  _"A customer with a saved address can create an order; it appears in
  `SEARCHING`; an unverified master cannot see it."_

Acceptance criteria describe outcomes a reviewer can check without reading the
implementation.

## Examples

### Bad

```
Implement authentication
```

Unreviewable, unestimable, unfinishable. There is no way to tell when it is done.

### Good

```markdown
# Implement customer phone authentication with refresh-token rotation

## Objective

Let a customer sign in with a phone number and OTP, receiving an access/refresh
token pair with rotation and reuse detection.

## Context

Blocks all customer-facing work. Design: docs/architecture/authentication.md.
OTP delivery provider is still open (ADR-0008) — this issue uses a stub sender
behind the provider interface.

## Requirements

- [ ] POST /auth/otp/request — accepts a phone number, sends a code via the sender interface
- [ ] POST /auth/otp/verify — verifies and returns an access + refresh pair
- [ ] POST /auth/refresh — rotates the refresh token
- [ ] POST /auth/logout — revokes the current session
- [ ] Refresh tokens stored hashed, one row per device session
- [ ] Reuse of a spent refresh token revokes the whole session family
- [ ] Rate limiting per phone and per IP

## Technical considerations

- Role claims are re-checked against the database on every authorization
  decision — never trusted from the token
- Refresh tokens are stored hashed; the plaintext exists only in the response
- Tokens live in `expo-secure-store` on the client, never `AsyncStorage`
- The OTP request and verify responses must not reveal whether a number is
  already registered
- The sender is an interface with a stub implementation (`SMS_PROVIDER=stub`)
  until a provider is chosen; swapping it must not touch a call site

## Acceptance criteria

- [ ] A new phone number can complete sign-up and receives a valid token pair
- [ ] An expired access token is rejected with 401
- [ ] Refreshing returns a new refresh token and invalidates the previous one
- [ ] Replaying a spent refresh token revokes every session for that user
- [ ] Exceeding the OTP request limit returns 429
- [ ] The response is identical for a known and an unknown phone number

## Testing requirements

- [ ] Integration tests for each endpoint
- [ ] Refresh reuse detection test
- [ ] Rate limit trigger and reset
- [ ] No token, OTP code, or full phone number appears in logs

## Dependencies

Blocked by #1 (foundation). Sign-in method confirmation (ADR-0008).

## Definition of Done

Per CLAUDE.md §8.
```

The second version can be picked up by anyone, reviewed against its criteria, and
verified.

## Sizing

| Label         | Meaning                                     |
| ------------- | ------------------------------------------- |
| `size:small`  | Focused, one area                           |
| `size:medium` | Several files or a full endpoint with tests |
| `size:large`  | **Should probably be split**                |

`size:large` on a sub-issue is a signal, not a category. Split it.

## Labels

Every implementation issue: at least one `type:`, one `area:`, one `priority:`,
one `size:`. Full list: [`../engineering/github-workflow.md`](../engineering/github-workflow.md).

Use `needs-design-decision` when work is blocked on the owner's visual or product
input (CLAUDE.md §17). That label is how "we are waiting on you" stays visible
instead of becoming an invented answer.

**Status labels move with the work.** `status:in-progress` when the branch is
created, `status:review` when the PR is opened, `status:blocked` when the issue
is waiting on something else, and the issue is closed from the merged PR.
CLAUDE.md §7 lists the engineering steps and does not mention labels; setting
them is part of the GitHub workflow
([`../engineering/github-workflow.md`](../engineering/github-workflow.md)) and is
not optional. The two documents describe the same task from different angles —
neither replaces the other.

## Assignment

Every implementation issue is assigned to **`ismetcahangirov`**.

## Keeping issues honest

- Update the issue when reality diverges from the plan. A surprise found during
  implementation belongs in the issue, not only in a commit message.
- If an issue turns out to be two issues, split it rather than quietly widening
  it.
- Close from a merged PR, and only when the Definition of Done is met.
- Do not close an issue as "done" with known gaps. Note the gap and open a
  follow-up ([CLAUDE.md §20](../../CLAUDE.md)).

## Never put in an issue

The repository is **public**.

- Credentials, tokens, connection strings
- Real personal data — phone numbers, addresses, customer names
- Unreported security vulnerability detail — an issue is a public disclosure.
  Contact the owner directly ([`../engineering/security.md`](../engineering/security.md)).
