# ADR-0064 — A master awaiting review can set their services

- **Status:** **Accepted**
- **Date:** 2026-10-25
- **Decided by:** Project owner, on 25 October 2026. Asked whether a master waiting on verification should get the "Xidmətləri idarə et" button, the owner answered "hə, et".
- **Context:** EPIC 5 (master profile). No issue: the auto-mode classifier denies `gh issue create` in this repository, so the pull request records the reason.
- **Supersedes in part:** [ADR-0063](ADR-0063-master-services-screen.md) § 2 ("Only an active master reaches it").

## Context

Dispatch offers an order only to a master who actively offers its service. Under ADR-0063 § 2, the services screen was reachable only by an active master. So a master's list was always empty at the moment of approval, and they could get no offers until they went and filled it in. `docs/product/master-flow.md` gave a master waiting on review "nothing to do".

## Decision

1. **A master whose status is `pending_verification` or `changes_requested` is offered "Xidmətləri idarə et"**, as the action of the own-profile empty state. These are the two statuses on the way to approval.
2. **`rejected` and `suspended` masters are not offered it.** A rejected master's path is an appeal, not approval (still an open decision). A suspended master is not about to start work.
3. **Nothing else changes.** The screen is the one ADR-0063 lays out, and the API already allowed it: `requireOwnProfile` asks only that the profile exists. Dispatch still offers nothing to a master who is not active, so services set early are preparation, not eligibility.

## Consequences

- `OwnProfile`'s not-active empty state carries the button for those two statuses.
- `docs/product/master-flow.md`'s state table says a master awaiting review can prepare their services.
