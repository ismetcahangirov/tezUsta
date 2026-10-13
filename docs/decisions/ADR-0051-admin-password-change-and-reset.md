# ADR-0051 — An admin changes their password, and a super_admin resets one

- **Status:** Accepted
- **Date:** 13 October 2026
- **Decided by:** Issue #329 (the owner's specification)
- **Context:** issue #329; EPIC 20 (#327)
- **Amends:** [ADR-0043](ADR-0043-admin-panel-policy.md) § 2–3 (credentials and
  setup links). ADR-0043 is otherwise unchanged.

## Context

Admins sign in with an email, a password and a TOTP code (ADR-0043 § 2). A
`super_admin` could reset a lost **authenticator**, but nothing covered a lost
**password**. An admin also had no way to rotate a password before it leaked.

## Decision

### 1. Changing your own password

`POST /admin/me/password` takes the current password, the new one and a fresh
TOTP code. A stolen session cookie alone therefore cannot change the password
and lock its owner out.

- **One error for both factors.** A wrong current password and a wrong code
  both answer `400 ADMIN_CREDENTIALS_INVALID`. The caller already holds a
  session; telling the two apart would let a stolen session test password
  guesses without the authenticator.
- **The sign-in budget.** Every attempt spends the account's `admin-sign-in`
  budget: the same Redis counter, keyed by the same lower-cased email. A wrong
  guess here counts toward the same five-per-window lockout as one on the
  sign-in form, and a locked account is refused here too (`429`).
- **The code is claimed.** As on sign-in, a code accepted here is never
  accepted again.
- **The new password** follows the setup rule: 12 to 128 characters, hashed
  with the current scrypt parameters. There is no breached-password check,
  because the setup flow has none.
- **Sessions.** Every **other** session of that admin ends. The one the change
  was made from stays open.
- **Audit.** The change is audited as `admin.password.change`, with no before
  or after, because what changed is a secret.
- **Who.** Any admin may change their own password, including one with no
  role.

### 2. A super_admin resets a colleague's password

`POST /admin/admins/:id/reset-password` takes a reason and needs
`admins.manage`.

- **The old password stops at once.** The hash is cleared and every session
  ends. The authenticator is **kept**.
- **The link.** It reuses the setup-link machinery: one table, a token stored
  only as its digest, single-use, valid 24 hours. A new column,
  `admin_invitations.purpose`, separates `setup` (enrol a new authenticator)
  from `password_reset` (keep it).
- **On the link.** The admin sets a new password and proves a code from the
  authenticator they already have. A code tried there spends the account's
  sign-in budget too, so a leaked link cannot be used to guess faster than the
  sign-in form allows. No new secret is offered. The code is
  claimed, and the link is spent in the same transaction, under the same row
  lock as setup.
- **Handing it over.** The link is shown once to the `super_admin` and never
  emailed (ADR-0043 § 3).
- **Refused cases.** A `super_admin` cannot reset their own password this way
  (`ADMIN_SELF_ACTION_REFUSED`); they use § 1. An admin who never finished
  setup has nothing to prove the link with, so their reset is refused, and the
  second-factor reset (a fresh invitation) is the way back.
- **Audit.** Issuing is audited as `admin.password.reset_issued` with its
  reason. Completing is audited as `admin.password.reset_completed`. Neither
  carries a secret.

### 3. No public "forgot password"

A reset is issued by a `super_admin` from the accounts list, never from a public
form. That way no response can reveal whether an email belongs to an admin.

## Consequences

- An admin with a reset pending still shows as enrolled, because the
  authenticator is kept, and with a link pending until they complete it.
  Issuing a second reset replaces the first link.
- A `super_admin` who loses both their password and their authenticator, with
  no other `super_admin` to help, still recovers with
  `admin:bootstrap --reissue` (ADR-0043 § 3).
