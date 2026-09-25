# Incident response

What to do when something has gone wrong with security or privacy: a leaked
secret, a stolen account, an abuse campaign or data reaching someone it should
not. This page lists the levers that **exist in the code today**, not the ones
we would like to have.

Hosting is still an open decision (CLAUDE.md §1). Steps that depend on the host
("redeploy", "restart") say so. When EPIC 17 picks a provider, fill in the
provider-specific commands here and keep the rest.

## First fifteen minutes

1. **Contain before you investigate.** Revoke, rotate or disable first. You
   can read the logs afterwards, but a live key keeps working while you read.
2. **Open a private record** of the incident: a private note or a security
   advisory draft on GitHub, **never a public issue**. The repository is public,
   so a public issue is a disclosure (see [security.md](security.md)).
3. Write down, with absolute UTC timestamps: when it was noticed, by whom, what
   was seen, and every action taken. You will need this for the post-incident
   review and, if personal data was involved, for whoever handles notification.
4. Pick a severity:

| Severity | Meaning                                                                                 | Example                                                            |
| -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **SEV1** | Personal data or server authority is exposed now, or someone is physically at risk      | Committed `DATABASE_URL`; a master sees other customers' addresses |
| **SEV2** | An abuse vector is being used, or a secret leaked that grants billing power but no data | SMS budget draining; `GOOGLE_MAPS_SERVER_API_KEY` published        |
| **SEV3** | A weakness nobody is known to be using                                                  | A missing rate limit found in review                               |

SEV1 and SEV2 are handled now. SEV3 becomes a normal `type:security` issue,
worded so that the issue itself is not an exploit guide.

## Playbooks

### A secret was committed or published

Removing a secret from git history does **not** un-leak it. The repository is
public, and the value is compromised from the moment of the push. **Rotate
it**, then clean history if you want to.

What rotating each secret does. Know this before you do it:

| Secret                                      | Rotating it…                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`                         | Invalidates every access token at once. Clients refresh transparently, so users barely notice.                                            |
| `JWT_REFRESH_SECRET`                        | Refresh-token hashes are keyed by it (`sessions.ts`), so **every user is signed out** and needs a new OTP. Also invalidate access tokens. |
| `JWT_ADMIN_ACCESS_SECRET`                   | Every admin is signed out of the panel.                                                                                                   |
| `OTP_CODE_PEPPER`                           | OTP challenges in flight fail; users request a new code. Harmless.                                                                        |
| `RATE_LIMIT_KEY_SECRET`                     | Resets every rate-limit counter. Rotate it outside an ongoing abuse campaign if you can.                                                  |
| `ADMIN_TOTP_ENCRYPTION_KEY`                 | Stored TOTP secrets become unreadable. **Every admin must re-enrol** a second factor (`reset-second-factor`, then setup link).            |
| `DATABASE_URL` credentials                  | Change the Postgres role's password, update the env, restart every API and worker instance.                                               |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Create a new R2 token, deploy it, then delete the old one in Cloudflare. Presigned URLs already issued die with the old key.              |
| `GOOGLE_MAPS_SERVER_API_KEY`                | Create a new key in Google Cloud, deploy, delete the old one. Check billing for usage while it was exposed.                               |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`    | New key pair in LiveKit; the webhook signature also changes. Calls in progress drop.                                                      |
| `EXPO_ACCESS_TOKEN`                         | Revoke it in the Expo dashboard and issue a new one. Pushes fail until it is deployed.                                                    |
| `EXPO_PUBLIC_GOOGLE_MAPS_*`                 | Not a secret (security.md). Check the key's bundle-id and API restrictions are still in place.                                            |

Every secret is validated at boot by `apps/api/src/infra/config/env.schema.ts`.
If a rotated value is missing, the process refuses to start instead of starting
insecure.

### One account is compromised

- **The user reports a lost or stolen phone:** revoke all of their sessions.
  `POST /auth/logout-all` does this from any device they still hold. An admin
  can do it for them by suspending and then reinstating (masters only), or directly
  in SQL (below).
- **Refresh-token reuse detected:** handled automatically. The session family
  is revoked with reason `reuse_detected` and kept per
  [ADR-0027](../decisions/ADR-0027-refresh-token-incident-retention.md). Look at
  those rows when you investigate.
- **A master is abusing the platform:** suspend them in the admin panel
  (`POST /admin/masters/:id/suspend`). This revokes every session, blocks
  accepting orders and writes the audit log with the admin and the reason.
- **A customer is abusing the platform:** there is **no admin action yet**. Use
  SQL, attributed in the incident record:

  ```sql
  update users set status = 'suspended', updated_at = now() where id = '<user id>';
  update sessions set revoked_at = now(), revoked_reason = 'suspension'
   where user_id = '<user id>' and revoked_at is null;
  ```

  `ActorService` rejects a user who is not active on every request, and a
  refresh does the same. The SQL takes effect at the user's next request.

- **An admin account is compromised:** another `super_admin` disables it
  (`POST /admin/admins/:id/disable`) and resets its second factor. If it was
  the only `super_admin`, rotate `JWT_ADMIN_ACCESS_SECRET` and create a new one
  with `pnpm --filter api admin:bootstrap`. Then read `admin_audit_log` for
  everything that account did.

### An abuse campaign is running

Every rate limit is an environment variable in `env.schema.ts` (`*_RATE_LIMIT_*`)
backed by Redis, so tightening one means changing the value and restarting.
You do not need a code change.

- **SMS cost attack:** lower `OTP_RATE_LIMIT_PER_IP_HOUR` and
  `OTP_RATE_LIMIT_PER_PHONE_HOUR`. If it continues, pause sending with the SMS
  provider (no provider is chosen yet, so write down how here when one is).
  A paused provider stops all sign-in, so that is a decision for the owner.
- **Spam orders:** lower `ORDER_CREATE_RATE_LIMIT_PER_USER_HOUR` and suspend
  the accounts involved.
- **Location spoofing or offer grabbing by a master:** suspend the master.
  A suspended master cannot accept any offer; eligibility is re-read from the
  database on accept, not taken from the offer.

### Personal data reached the wrong person

1. Stop the leak. Revert or hotfix the route, or take it offline.
2. Work out **exactly** which records were exposed and to whom. For admin
   reads use `admin_audit_log`, since a read is an audited action. Use request
   logs to find which user ids called the affected route.
3. Preserve the evidence before any retention sweep deletes it.
   `master_locations`, OTP challenges (#276) and sessions all age out
   automatically.
4. Hand the list to the owner. Whether and how affected people and any
   authority must be told is a **legal** question, not an engineering one. No
   Azerbaijani data-protection obligation has been established by this
   repository yet (security.md § PII and privacy).

## Where to look

| Question                        | Source                                                                  |
| ------------------------------- | ----------------------------------------------------------------------- |
| What did an admin do?           | `admin_audit_log`: actor, action, target, reason, before/after          |
| Why was a user signed out?      | `sessions.revoked_reason`                                               |
| Who was rate-limited, and when? | API logs at `warn`. Rate-limit triggers are always logged (security.md) |
| What happened to an order?      | `order_status_history`, and the admin order screen                      |
| Which request caused an error?  | The `requestId` on the log line and in the client's error response      |

Logs never contain tokens, OTP codes, full phone numbers or coordinates
(security.md § Logging). If you find one that does, that is a second incident.

## After the incident

- Write a short blameless review in the private record: timeline, root cause,
  what worked, what did not.
- Every root cause gets a fix issue labelled `type:security`, and a test that
  would have caught it.
- If a lever was missing, like the customer suspension above, it gets an issue
  too, and this page is updated when the lever lands.
