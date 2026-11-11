# ADR-0075 — The admin panel uploads to the private bucket, through one CSP origin

- **Status:** **Accepted**
- **Date:** 2026-11-11
- **Decided by:** Project owner. Shown three options for #524 with the recommendation below, the owner chose it on 11 November 2026.
- **Context:** Issue #524, the evidence photos of a master's account recovery.
- **Amends:** [ADR-0052](ADR-0052-serving-the-admin-panel.md) § 3, the panel's CSP. ADR-0052 asks for this change and a review when the panel first needs another origin.
- **Builds on:** [ADR-0005](ADR-0005-object-storage.md) and [ADR-0024](ADR-0024-presigned-upload-mechanism.md) (presigned PUT straight to the private bucket, checked at confirm), [ADR-0074](ADR-0074-account-recovery-and-email-change.md) § 2 (the master's recovery evidence).

## Context

ADR-0074 § 2 asks a master who lost their sign-in address for a fresh selfie
with the same ID card and a photo of the card's front. #524 stores them on the
request, privately, like the ADR-0023 documents. Support receives them by
email and adds them in the panel.

Every upload in TezUsta works one way (ADR-0005, ADR-0024). The API presigns a
PUT to the private bucket, the client sends the bytes there, and the API
confirms by checking the real size and the leading bytes. The bytes never pass
through the API.

The mobile app is not a browser, so it needs no CORS rule and no CSP. The
panel is a browser page whose CSP (ADR-0052 § 3) lets it connect to its own
origin only. A PUT to the bucket's origin is blocked before it leaves the
browser.

## Decision

1. **`connect-src` gains one origin, and only when it is configured:** the
   private bucket's upload origin, from `PANEL_STORAGE_UPLOAD_ORIGIN` on the
   panel's image. Unset or empty, the policy is exactly ADR-0052's. No other
   directive changes: scripts, styles, images, fonts and frames stay `'self'`.
2. **The value is checked when the container starts.** It must be one `https`
   origin: a scheme, a lower-case host and an optional port. Anything else,
   such as a path, a second origin or a `;`, stops the container, so a typo
   cannot widen the policy.
3. **The bucket allows the panel's origin for `PUT` only,** with the
   `Content-Type` header, in its CORS rules. This is set where the bucket is
   configured, not in this repository.
4. **The upload mechanism is ADR-0024's, unchanged:** a server-made key, a
   presigned PUT with a short life, and a confirm that checks the size cap and
   the magic bytes and deletes what fails. Reads stay presigned GETs opened in
   a new tab, which the CSP does not govern.

## Why

- It keeps one upload pipeline. #524 asks for exactly that, and the confirm
  checks are the security boundary, wherever the bytes come from.
- `connect-src` to our own bucket lets the page send bytes to a place that
  only takes them through a URL the API signed for one key, one content type
  and a few minutes. It cannot load code from there.
- Validating the origin at start keeps the change to the one origin it
  names.

## Alternatives considered

- **Upload through the API.** No CSP or CORS change, but the bytes pass through
  the API, against ADR-0005. It needs a second path with its own body limits,
  and #524 asks for no second pipeline.
- **Proxy the bucket through the panel's nginx.** Same-origin, but the proxy
  would have to rewrite the host a presigned URL is signed for, and it puts
  another moving part in front of identity documents.
- **No upload in the panel.** The photos stay in the support mailbox, which is
  what #524 exists to end.

## Trade-offs accepted

- One more origin in the panel's CSP when configured.
- A deployment step outside the repository: the bucket's CORS rule. Without it,
  the panel says the upload could not reach storage, and nothing is stored.

## Consequences

- `apps/admin/deploy/nginx`: `connect-src` comes from a `map` on
  `PANEL_STORAGE_UPLOAD_ORIGIN`, and `15-panel-storage-origin.sh` checks it.
  The Dockerfile sets it to empty by default.
- The recovery request page in the panel adds the two photos (#524).
- `docs/architecture/authentication.md` § recovery names the variable and the
  CORS rule.

## Revisit when

- The panel needs a second origin of any kind.
- The bucket moves to a provider whose presigned upload origin differs per
  object, so one origin no longer covers it.
