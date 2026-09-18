# ADR-0024 — Cloudflare R2, and where the upload size cap is actually enforced

- **Status:** **Accepted** (data-residency check still outstanding)
- **Date:** 2026-09-18
- **Decided by:** Project owner (provider), engineering (mechanism)
- **Amends:** [ADR-0005](ADR-0005-object-storage.md) — finalises the provider
  it left pending, and replaces one row of its mandatory-controls table
- **Unblocks:** EPIC 5 [#38](https://github.com/ismetcahangirov/tezUsta/issues/38),
  EPIC 6 order photos

## Context

[ADR-0005](ADR-0005-object-storage.md) settled the architecture — S3-compatible
storage, the client PUTs directly through a presigned URL, image bytes never
pass through the API — and left the **provider** open, recommending Cloudflare
R2 because the workload is write-once / read-many and R2 charges no egress.

It also fixed a table of mandatory server-side controls, one of which reads:

> | Hard size cap enforced in the presign policy | The cap must be in the
> policy, not just checked after upload — otherwise the upload already
> happened |

Implementing #38 turned up that **those two cannot both be true.**

The only mechanism in the S3 API that binds a size range into a signature is
the **POST form policy** — `POST /bucket` with a base64 policy document
carrying a `content-length-range` condition. A presigned **PUT** has no
equivalent: `Content-Length` is a request header, and signing it would pin an
exact byte count rather than a range, which is an equality check every client
that recompresses would fail.

Cloudflare's own documentation is explicit that R2 does not implement POST:

> R2 supports presigned URLs for the following HTTP methods: GET, HEAD, PUT,
> DELETE. **POST (multipart form uploads via HTML forms) is not currently
> supported.**
>
> — [developers.cloudflare.com/r2/api/s3/presigned-urls](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

So choosing R2 forecloses the mechanism ADR-0005 mandated. The choice was put
to the owner as a real trade — keep R2 and move the cap, or take AWS S3 and pay
egress for the literal control — and answered on 2026-09-18.

## Decision

### 1. The provider is Cloudflare R2

ADR-0005's recommendation stands and is now the decision. Egress is the
dominant cost line for a read-heavy image workload, R2 removes it, and it keeps
the S3 API, so the choice stays reversible.

### 2. Uploads use a presigned PUT

One mechanism, on every provider. `Content-Type` **is** signed, so an upload
that declares something other than what was presigned is refused by storage
rather than by us.

### 3. The size cap is enforced at confirm, against the real object

This replaces the ADR-0005 row quoted above. The flow is:

```
client → POST /masters/me/documents/presign   → { documentId, uploadUrl, maxBytes }
client → PUT  <uploadUrl>                      (direct to storage)
client → POST /masters/me/documents/:id/confirm
         server → HeadObject        → the REAL size; over the cap ⇒ delete, 422
         server → ranged GET, 12 B  → the REAL type; contradicts ⇒ delete, 422
         server → conditional UPDATE awaiting_upload → pending_review
```

`maxBytes` is also returned to the client, so the app can refuse an oversized
photo before spending a master's mobile data on it. **That is a courtesy, not
the control** — the control is the `HeadObject`.

### 4. A presigned URL is made single-use by this server

AWS documents that a presigned URL "can be used multiple times, up to the
expiration date and time", so single-use is not something S3 offers. The
`master_documents` row in `awaiting_upload` is the server's record that this
key was issued to this master for this document, and confirming it is a
conditional transition out of that status. Two concurrent confirms both attempt
it; exactly one wins.

## What is lost, precisely

**An oversized or mislabelled file can be uploaded once before it is refused.**
It is then deleted and never becomes attachable to anything.

What that costs is bandwidth and a few seconds of storage. What it does **not**
cost is a security property:

- The object is in a **private** bucket with no public URL. Nothing serves it.
- It is never referenced by a row that any read path will follow — the row
  stays in `awaiting_upload` until confirm, and a failed confirm deletes both.
- Magic-byte validation was always going to happen after the upload. There is
  no signature mechanism on any provider that inspects file contents, so
  ADR-0005's own control list already required a post-upload step. The cap
  simply joins it.

The bandwidth exposure is bounded by the things that were never in the
signature anyway: authentication, a master profile, an account status that
permits uploading, the `document-upload` rate limit (30 presigns per master per
hour), and a partial unique index allowing at most one outstanding presign per
document type.

## Alternatives considered

| Alternative                                                    | Why not                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS S3 with a POST policy**                                  | Delivers ADR-0005's literal control: `content-length-range` is signed, and an oversized upload is refused by storage before a byte lands. Rejected on cost — egress is billed per GB and this is a read-many workload, which is the exact reason ADR-0005 recommended R2 in the first place. The trade was put to the owner explicitly. |
| **Backblaze B2 or another S3 provider with POST**              | Same shape of answer as S3, and buys the control back, but higher latency to the Caucasus and a smaller ecosystem (ADR-0005's own table). Not worth reopening the provider question for one control that is recoverable at confirm.                                                                                                     |
| **Sign `Content-Length` exactly on the PUT**                   | Turns a cap into an equality check. A client that recompresses, strips EXIF, or is off by a byte fails the upload with a signature error, which is unusable and unexplainable.                                                                                                                                                          |
| **Accept the object and check the size later, asynchronously** | The window where an oversized object exists _and is referenced_ is exactly what must not exist. Checking inside the confirm request keeps "validated" and "attachable" the same moment.                                                                                                                                                 |
| **Cap uploads by limiting the request at a proxy**             | There is no proxy in the path — the client talks to storage directly, which is the whole point of presigning.                                                                                                                                                                                                                           |

## Consequences

- `apps/api/src/infra/storage/` holds the provider interface and two
  implementations: `S3StorageProvider` (used against R2, and against anything
  else speaking S3) and `StubStorageProvider`, which keeps objects in memory
  and **refuses to construct under `NODE_ENV=production`** — the same
  construction `StubSmsSender` uses, for the same reason.
- No provider-specific SDK feature is used anywhere, so ADR-0005's
  reversibility constraint still holds after the provider was chosen.
- `StorageProvider.presignUpload` takes `maxBytes` even though the S3
  implementation cannot bind it. That is deliberate: the day TezUsta moves to a
  provider that supports POST policies, one file changes and no caller does.
- A **data-residency check** — whether Azerbaijani regulation constrains where
  customer-supplied images may be stored — was one of ADR-0005's two conditions
  for finalising a provider, and it remains outstanding. It is a legal
  question, not a technical one, and it can invalidate the provider half of
  this ADR without touching the mechanism half.

## Testing note, stated plainly

The upload leg is exercised through `StubStorageProvider`, not against a real
S3 implementation. Every control this ADR describes — the cap, the sniff, the
delete on rejection, single-use confirm, ownership — is tested; **the SigV4
signature itself is not**, because the client-side PUT is not this codebase's
code and there is no maintained S3 test double worth adding.

That gap is real and named rather than papered over. `minio/minio`, the usual
answer, was archived by its owner on 2026-04-25 and its community container
image has been frozen since 2025-09; `adobe/S3Mock` is maintained but documents
that it accepts presigned URLs **without validating** the signature, expiry or
HTTP verb, so a test against it would pass whether or not the signing worked.
Closing the gap properly means pointing the integration suite at the real R2
bucket, which is a decision about credentials in CI rather than about code.
