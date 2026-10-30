# ADR-0061 — The master's web subscription page: `apps/web`, phone + OTP into a narrow cookie session, no sign-in link

- **Status:** **Accepted (layout, copy and the public domain are the owner's)**
- **Amended by:** [ADR-0072](ADR-0072-email-one-time-code-sign-in.md) — the
  master signs in with email + a code sent by email instead of phone + SMS code.
  Everything else here stands.
- **Date:** 2026-10-23
- **Decided by:** Project owner. On 23 October 2026 the owner accepted the recommendation for [#334].
- **Context:** EPIC 14 (#15), issue [#334]
- **Builds on:** [ADR-0046](ADR-0046-subscription-only-monetisation.md) § 7 (the subscription is sold outside the app), [ADR-0008](ADR-0008-otp-delivery.md) (phone + OTP), [ADR-0014](ADR-0014-admin-authentication.md) and [ADR-0052](ADR-0052-serving-the-admin-panel.md) (the admin panel's cookies and proxy, which this mirrors), [ADR-0057](ADR-0057-subscription-billing-port.md) and [ADR-0058](ADR-0058-subscription-auto-renewal.md) (checkout and auto-renewal).

[#334]: https://github.com/ismetcahangirov/tezUsta/issues/334

## Context

ADR-0046 § 7 sells the master subscription on a web page, never in the app, because of Apple 3.1.1 and Google Play's payments policy. The checkout API exists (#323): `POST /masters/me/subscription/checkout` returns a hosted payment page, and only the provider's webhook extends a period. **Nothing on the web knows who a master is.**

What exists today:

- **Consumer sign-in** is phone + SMS OTP (ADR-0008), issuing a 15-minute HS256 access token with `aud = tezusta-consumer`, and a rotating opaque refresh token, both held in `expo-secure-store`. The guard reads only `Authorization: Bearer`.
- **The admin panel** is the only browser client. It has its own credential path (ADR-0014): its own secret, `aud = tezusta-admin`, its own session tables, httpOnly `SameSite=Strict` cookies with a required CSRF header, same-origin behind nginx with **no CORS** (ADR-0043 § 4, ADR-0052).
- **The OTP abuse controls** (#390) live inside `OtpService`, and the per-phone and per-IP budgets are rate-limit policies `otp-request` and `sign-in`.

Three questions were open on #334: where the page lives, how a master signs in there, and whether an SMS link may sign them in.

## Decision

### 1. A new app, `apps/web`, on its own origin

A small React + Vite single-page app, the admin panel's stack, served the way ADR-0052 serves the admin:

- an unprivileged nginx image, with the API reached **same-origin** under `/api` (no CORS, `connect-src 'self'`);
- a strict CSP, `frame-ancestors 'none'`, and the ADR-0052 header set. Unlike the admin, the page **may be indexed**: it is public, and a master may find it by search;
- **its own origin**, never a path of the admin panel's. The admin's cookies, CSP and allow-listed edge are for staff; a page every master opens must not share an origin with them. The domain is the owner's (hosting is still open, CLAUDE.md § 1).

It is not `packages/ui`'s second consumer in the ADR-0016 sense: a public purchase page and an internal console share design tokens, not components. The tokens are copied with a drift test, as the admin does. If a component is ever genuinely shared, that is when the package is created.

### 2. Sign-in: phone + OTP, into a web session of its own

The master signs in with their phone and an SMS code, **through the same `OtpService`**:

- the code request goes through `OtpService.request` under the existing `otp-request` policy, so every #390 control applies unchanged: the daily and hourly caps, the prefix and range caps, the circuit breaker, and the per-phone and per-IP budgets;
- the verify goes through `OtpService`'s code check under the existing `sign-in` policy.

What the verify issues is **not** the app's token pair:

- **An access token with its own audience**, `aud = tezusta-web`, signed with its own secret. It is refused everywhere a consumer token is accepted, and the reverse, by the same mechanism that keeps admin tokens apart today.
- **Two httpOnly cookies**, `Secure`, `SameSite=Strict`, `Path=/`, for the access and refresh tokens, and a **required CSRF header** on every cookie-authenticated request, as the admin does (ADR-0043 § 4). No token is ever readable by page script.
- **A short session.** The web session has a fixed absolute lifetime (`WEB_SESSION_TTL`, default 12 hours) and refresh rotation with reuse detection, as the app's sessions have. A payment page is visited, not lived in.
- **The session row is a consumer session marked as `web`**, so the master sees it in their session list in the app and can revoke it, and a suspension or "sign out everywhere" ends it too.

### 3. A web session reaches only the subscription

The web token is accepted **only on routes that opt in**, by an explicit marker on the handler; every other route refuses it. The opt-in set is exactly what the page needs:

- `GET /subscription` (prices, trial and grace days, whether purchases are open);
- `GET /masters/me/subscription` (status, period end, grace end, the queued next period);
- `POST /masters/me/subscription/checkout`;
- `GET` and `DELETE /masters/me/subscription/auto-renewal`;
- the web session's own sign-out and refresh.

A stolen web cookie can therefore buy a subscription for its owner and nothing else: no orders, no addresses, no messages, no location.

### 4. Who may sign in

- **The web sign-in never creates an account, and texts only masters.** A code is sent only to a phone whose account holds the master role. Any other phone gets the identical answer, and no SMS. The page says up front that it is for masters registered in the app.
  - **Nothing is learned from the answer.** It is the same for every phone, so the page cannot be used to ask whether a number is registered, or whose it is.
  - **Nothing is paid for a stranger's number.** A web form that texts any number it is given is exactly the SMS-pumping surface #390 guards against. This one cannot text a number that is not already a master's.
  - **A verify for such a phone fails like a wrong code**, because no code exists.
- **A suspended account is refused**, as on every other path (#328).
- **A master who is not verification-approved can sign in and see their status, but cannot start a checkout.** That refusal already exists (`assertCanAcceptWork`, `MASTER_NOT_ELIGIBLE`), and the page says why.
- **An admin credential cannot sign in here**, and a web session cannot reach `/admin`: admin auth is email, password and TOTP on its own surface (ADR-0014).

### 5. No sign-in link

**No SMS or e-mail link signs a master in.** A link that is itself a credential is forwarded, previewed by messaging apps and left in notification history, and every one of those is a session handed to somebody else. The code costs the master one more step, and it is the path every control above already guards.

An SMS that only names the page's address remains allowed (Apple 3.1.3, ADR-0046 § 7). Sending it is a separate, later decision; nothing here sends it.

### 6. What the page does

- **Status:** shows the master's status, period end and grace end, and the queued next period.
- **Prices:** shows the current monthly and yearly prices.
- **Purchases closed:** when `purchasesOpen` is false (#324), the page says so and offers nothing.
- **Checkout:** starts one for either period, with the ADR-0058 auto-renewal consent checkbox, and navigates the browser to the provider's hosted page. No card data passes through the page or the API.
- **After the provider sends the browser back** (`BILLING_RETURN_URL`), the page shows "confirming…" and re-reads `GET /masters/me/subscription` until the status changes. It stops after a bounded wait and says the payment will appear once confirmed. **The return is never proof of payment**; only the webhook extends a period (ADR-0057).
- **"Cancel" is turning auto-renewal off** (`DELETE …/auto-renewal`, ADR-0058). The paid period runs to its end. There is no refund path, and no master-facing endpoint ends a period early. Turning auto-renewal back on is a new checkout with consent, as ADR-0058 requires.
- **The app contains no link to the page**, no price and no call to action (ADR-0046 § 7). A test in `apps/mobile` asserts the page's origin appears nowhere in the app's source.

## Why

**The same sign-in the master already knows, and one set of controls.** A second credential (a password, an e-mail) would be something every master has to create for one page a year, and a second sign-in path with its own OTP budgets would be a second place for SMS pumping to get through. Calling the same `OtpService` under the same policy names makes the web path share every bucket the app's path fills.

**Cookies, not bearer tokens in browser storage.** A token in `localStorage` is readable by any script that reaches the page. The admin panel already proves the httpOnly-cookie-plus-CSRF-header pattern on this API, so the web page reuses a mechanism with tests, not a new one.

**Its own audience and an opt-in route set.** Without them, a web cookie would be a full consumer credential living in a browser, which is strictly worse than the app's token in the platform keystore. The narrow route set makes the worst case of a stolen web session "the owner's subscription was paid for".

**No account creation on the web.** Masters register and pass verification in the app (ADR-0023). An account created from a web page could never be a master, so allowing it would only add an unauthenticated way to create users.

**No sign-in link.** Its convenience is one fewer step on a page used a few times a year. Its risk is a credential sitting in every place a message is copied to.

## Alternatives considered

| Option                                                 | Why not                                                                                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A route of the admin panel                             | Shares an origin, cookies and a CSP with staff tooling, and puts every master on the staff panel's edge. ADR-0014 keeps the two credential paths apart; this would put them in one app. |
| A server-rendered page from the API                    | A second rendering stack in the API, and HTML responses on a service that today serves only JSON. The SPA reuses the admin's proven build, proxy and header set.                        |
| Reuse the app's consumer token pair in browser storage | A full consumer credential, readable by page script, with a 30-day refresh.                                                                                                             |
| A web token accepted on every consumer route           | A stolen browser cookie becomes the master's whole account: orders, addresses, live location.                                                                                           |
| Let the web sign-in create an account                  | No web-created account can ever be a master, so it adds an unauthenticated account-creation path for nothing.                                                                           |
| Text any phone, and refuse non-masters after the code  | Every non-master who tries costs an SMS, and the form becomes a way to make the platform text arbitrary numbers.                                                                        |
| A single-use, short-lived SMS sign-in link             | Forwarded, previewed by messaging apps, kept in notification history. Revisit only with evidence that the code step loses masters.                                                      |
| A separate OTP policy and budget for the web           | A second set of buckets is a second budget for an attacker to spend.                                                                                                                    |

## Trade-offs accepted

- **A new app to build, ship and secure:** its own image, nginx config, CSP and smoke test, like the admin's.
- **The consumer guard learns cookies**, for the web audience only. That is a second way a consumer request can be authenticated, deliberately limited to the opt-in routes.
- **Twelve hours, then sign in again.** A master who leaves the page open overnight gets a new code in the morning, and each code is an SMS the platform pays for.
- **No account creation and no link** mean a master with no app account cannot use the page at all. That is by design: masters exist only through the app's verification.
- **A customer who opens the page gets no code and no explanation beyond the page's own wording.** Telling them "you are not a master" would tell anyone typing a number whose number it is.

## Consequences

- **API:**
  - a web sign-in surface, with code request, verify, refresh and sign-out, calling `OtpService` under the existing policy names;
  - the `tezusta-web` audience and its secret, `JWT_WEB_ACCESS_SECRET`;
  - hand-rolled cookies and a CSRF header, as `admin-cookies.ts` does;
  - a `surface` column on `sessions` (`app` | `web`), and `WEB_SESSION_TTL`;
  - the opt-in marker, and a guard branch that refuses a web token on any route without it.
- **The stale statements this contradicts are corrected in the same change:**
  - `app-config.types.ts` says there is no browser client left and none is planned;
  - `auth.controller.ts` says there is no second sign-in route;
  - `docs/architecture/authentication.md` has the token-surface table.
- **`apps/web`:**
  - sign-in (phone, then code), the status and purchase page, the return page with bounded confirming, and the not-a-master, not-verified and purchases-closed states;
  - a Dockerfile, an nginx template and its header set, and a smoke test;
  - dependency-cruiser rules: no import into or out of the other apps.
- **`BILLING_RETURN_URL`** points at the page's return route once its domain exists.
- **Owner inputs:** the layout and the copy (CLAUDE.md § 17), and the public domain. They do not block building against `SMS_PROVIDER=stub` and the stub billing provider. Real use waits on the SMS accounts (ADR-0059) and a billing provider, as before.
- **CLAUDE.md § 1** lists this as settled.

## Revisit when

- Evidence shows masters abandoning the page at the code step, which is the one argument for a sign-in link.
- A component is genuinely needed by both `apps/admin` and `apps/web`: create `packages/ui` then (ADR-0016).
- The page needs anything beyond the subscription. Widening the opt-in route set is a new decision, not a one-line change.
