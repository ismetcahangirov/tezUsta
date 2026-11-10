# ADR-0074 — Changing the sign-in email address, and recovering an account whose address is lost

- **Status:** **Accepted (by delegation; the copy and the support address are the owner's)**
- **Date:** 2026-11-10
- **Decided by:** Project owner, by delegation. Shown the options in #499 with the recommendation "A + B", the owner answered "necə məsləhətdirsə" (whatever is advisable) on 10 November 2026. The answers below follow that recommendation; where #499 left a sub-question open, the stricter reading was taken.
- **Context:** Issue #499.
- **Settles:** [ADR-0072](ADR-0072-email-one-time-code-sign-in.md) § 8, the account-recovery half. The email provider half stays open (#498).
- **Builds on:** [ADR-0023](ADR-0023-master-verification-policy.md) (the master's ID evidence), [ADR-0043](ADR-0043-admin-panel-policy.md) (admin permissions, masked PII, audit), the "Email address change" row of [`authentication.md`](../architecture/authentication.md) § Sessions and devices.

## Context

Sign-in is an email address and a one-time code, and nothing else (ADR-0072),
so the address _is_ the account. ADR-0072 accepted "losing access to the email
address means losing the account" only on the condition that a recovery path
exists before launch, because the order history, the reviews and the master's
rating are attached to the account.

On `main` today:

- A user cannot change their own address, even while they still have it.
- An admin can reveal an address with a reason (ADR-0043 § 6), but cannot change it.
- A master has verified identity on file: the ID card front and back, and a selfie holding it (ADR-0023). Nothing deletes those documents while the account exists. A customer has nothing comparable.
- Admins already reset each other by hand rather than holding recovery codes (ADR-0043). That is the precedent for a person-mediated path.
- The app tells a user to contact support in two places, but no support channel exists.

The master's account is the valuable one: the rating, the reviews, the
portfolio and a paid subscription period. It is also the likeliest target of a
takeover, and the main takeover route against a support-mediated path is social
engineering of support. The rules below are shaped by that.

## Decision

### 1. A signed-in user can change their address (option A)

- From Settings → Hesab, a signed-in customer or master enters a new address.
- **A code goes to the new address and a second code to the current one.** Both must be entered. The new-address code proves control of the new mailbox. The current-address code means a stolen, unlocked phone with a live session is not enough to move the account.
- **A user who no longer receives mail at the current address cannot use this path.** They use § 2.
- On success: the address changes, **every session of the user is revoked** (the existing `authentication.md` rule), an audit row is written, and a notice goes to the old address.
- The send caps of ADR-0072 apply to both codes, per address and per IP.

### 2. Recovery after the address is lost goes through support (option B)

No second credential is added: no recovery email (option C), no recovery codes
(option D), and the phone number does not come back (option E).

**The request:**

- The locked-out user writes to the support address (§ 6) **from the new address** they want to use. That proves control of the new address from the start.
- A `support` admin opens a recovery request in the panel against the account, records the evidence below, and sends a code to the new address. The user reads it back to support, which proves the new address again at the moment of the move.
- **A request is refused when:** the new address belongs to another account (the partial unique index of ADR-0072 § 3); another recovery or change is pending on the account; or the account is suspended or deleted.

**The evidence, by role:**

- **Master:** a fresh selfie holding the same ID card, plus a photo of the card's front. The admin matches both against the ADR-0023 documents on file: the same card number, the same face. Without a match there is no move. This is the only bar strong enough for the account a takeover would aim at.
- **Customer:** a customer has no identity on file, so the bar is knowledge of the account. The admin asks, without prompting, for at least **three** of:
  - the display name;
  - the label and district of a saved address;
  - the service and the approximate date of a recent order;
  - the name of a master who worked on an order.

  The admin reads the answers against the account, never the other way round.

**The hold:**

- After the evidence is accepted, **the move waits 72 hours**, for both roles.
- At the start of the hold a notice goes to the old address. It says that a recovery was requested, from which new address (masked), and when the move will happen. It carries a **single-use cancel link**, valid until the move.
- Following the link cancels the request. Support can also cancel it on the user's word.
- The account keeps working normally during the hold. Nothing is frozen, so a false request costs the real owner nothing but an email.

**The move:**

- The move happens at the end of the hold, on approval by a `super_admin` **other than the admin who opened the request**. No single admin can both accept the evidence and move the account.
- It changes the address, **revokes every session** of the user, writes an audit row naming both admins and the reason, and sends a notice to both addresses.

### 3. Admin permissions

- A new permission, **`accounts.recover`**, in two steps:
  - **Open and verify:** `support` and `super_admin`. It includes reading the master's ID documents for the match. That read is audited, as `masters.read` already is.
  - **Approve the move:** `super_admin` only, and never the same admin who opened the request.
- Both addresses are shown masked in the panel unless `pii.read` reveals them with a reason (ADR-0043 § 6).

### 4. What happens to money and work

- **A subscription period continues** through the hold and the move. It belongs to the master, not to the address.
- **Open orders and an active job continue.** The move only revokes sessions: the master signs in again with the new address and finds the job where it was. A move is not refused because a job is active, because refusing it would keep a stolen account in an attacker's hands for as long as they keep a job open.
- **Ratings, reviews, the portfolio and the order history move with the account,** because nothing about them is keyed on the address.

### 5. What the old address receives

| Event                             | Notice to the old address                           |
| --------------------------------- | --------------------------------------------------- |
| Self-serve change completed (§ 1) | Yes: the change, the time, and how to reach support |
| Recovery request opened (§ 2)     | Yes, with the cancel link                           |
| Recovery cancelled                | Yes                                                 |
| Recovery move completed           | Yes, and to the new address too                     |

No notice contains a code or a sign-in link. The wording is the owner's copy
(CLAUDE.md § 17). Placeholders are used until it exists.

### 6. The support channel

- A support mailbox on the product domain, for example `support@<domain>`. The domain is not chosen yet (#498, #505).
- It is shown under the sign-in form ("E-poçtunuza girişiniz yoxdur?") and in the footer of every email TezUsta sends.
- The same address replaces the two "contact support" messages that today name no channel.

## Why

- **Option A prevents most losses before they happen.** "I'm closing this mailbox" is the common case, and needs no admin.
- **Two codes, not one, on the self-serve path.** A code to the new address alone would let anyone holding an unlocked phone move the account to a mailbox they control. The cost of the second code is nothing to a user who still has the old address, and the user who does not is exactly the § 2 case.
- **Option B adds no credential and no personal data.** Every self-serve alternative adds something the user must keep and can lose (codes), or more personal data to hold (a second address).
- **The master's bar reuses evidence the platform already verified.** An attacker who can produce the master's own ID card and face can already pass verification as them.
- **The hold and the notice make a takeover visible before it lands.** A real owner who still reads the old mailbox stops it with one tap. A real owner who has lost it waits three days, once.
- **Two admins on the move** answers the main risk of option B: one support person talked into it.

## Alternatives considered

| Option                                            | Why not                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A code to the new address only, on § 1            | A stolen unlocked phone would be enough to take the account.                                                                    |
| C — a second, recovery email address              | More personal data, a step at sign-up, and a second address that goes stale just like the first.                                |
| D — recovery codes shown once at sign-up          | Users lose them. ADR-0043 rejected them for admins as "a second credential to store and leak".                                  |
| E — bring the phone number back                   | The owner removed phone numbers from the product completely (ADR-0072).                                                         |
| No hold for masters, since the ID match is strong | A lost or copied ID card is exactly the case the hold catches. The cost is three days, once.                                    |
| One admin can open and approve                    | Leaves the whole path to whoever is talked into it. A small team can still find a second `super_admin` within the 72-hour hold. |
| Freeze the account during the hold                | Would let anyone with a guess at a customer's details lock the real owner out for three days.                                   |

## Trade-offs accepted

- **A locked-out user waits at least 72 hours** to get back in, and needs a human. That is slow, but the event is rare and the account is the asset.
- **The customer's bar is knowledge, not identity.** Someone close to the customer may know the answers. The hold and the notice to the old address are the check on that, and a customer account holds less of value than a master's.
- **Two `super_admin`s are needed for a move.** With one `super_admin`, a move waits until a second one is invited (ADR-0043 § 3).
- **Support handles identity documents in the panel.** That read is already audited (ADR-0023), and `support` already holds `masters.read`.

## Consequences

- **API:**
  - `POST /me/email-change` and its confirm step (§ 1), with two codes and the existing caps.
  - An `account_recovery_requests` table: the user, the new address, the opening admin, the evidence notes, `opened_at`, `hold_until`, `cancelled_at`, `approved_by`, `moved_at`, and the cancel token's hash.
  - Admin endpoints to open, cancel and approve a request, under `accounts.recover`.
  - A public cancel endpoint for the link in the notice.
  - Every move goes through one function that changes the address, calls `revokeAllSessionsForUser`, writes the audit row and sends the notices.
- **Mobile:** the email-change screen in Settings → Hesab, and the support line under the sign-in form.
- **Admin panel:** the recovery request view, with a side-by-side view of the master's documents on file against the new photos.
- **Email:** four new notice templates (§ 5). They need the provider (#498) to reach a real mailbox.
- **CLAUDE.md § 1:** "Account recovery when access to the email address is lost" leaves the open-decision table.

## Revisit when

- Support handles more recovery requests than one person can review in a day: that is the point to look at a self-serve path.
- A master takeover gets through this path, or a real owner is locked out by it.
- The product adds a second sign-in factor, which would give recovery something stronger to rest on.
