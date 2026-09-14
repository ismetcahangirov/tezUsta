# ADR-0005 — Object storage for problem photos

- **Status:** **Architecture accepted; provider PENDING user decision.**
- **Date:** 2026-09-14

## Context

Customers attach photos of the problem (a leaking pipe, a broken lock) when
creating an order. Masters may attach completion photos. These are user-supplied
binaries from untrusted clients.

## Decision — architecture (ACCEPTED)

**S3-compatible object storage, written directly by the client via a presigned
URL. Image bytes never pass through the API.**

```
client → POST /uploads/presign        (authenticated; declares type + size)
       ← { uploadUrl, key, expiresAt }
client → PUT  <uploadUrl>             (direct to object storage)
client → POST /orders { photoKeys }   (API validates the keys it issued)
```

**Photos are never stored in PostgreSQL.** Image bytes in the database inflate
every backup, evict useful pages from shared buffers, and slow replication —
for data that has no relational value. The database stores the key; storage
stores the bytes.

### Mandatory server-side controls

Every one of these is required, because the client is untrusted:

| Control                                                                     | Why                                                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Presigned URLs are short-lived (≤ 5 minutes) and single-use                 | Limits the window of a leaked URL                                                                    |
| Content-type **allow-list** (`image/jpeg`, `image/png`, `image/webp`)       | An allow-list fails closed; a deny-list does not                                                     |
| Hard size cap enforced in the presign policy                                | The cap must be in the policy, not just checked after upload — otherwise the upload already happened |
| **Magic-byte validation of the actual content**                             | A declared `Content-Type` is a client assertion, not a fact. Validate the leading bytes server-side. |
| Keys are server-generated UUIDs, never client-supplied filenames            | Prevents path traversal and collisions                                                               |
| Stored in a **private** bucket; reads go through short-lived presigned GETs | A photo of someone's home interior with an implicit address is not public data                       |
| Photo keys bound to the issuing user and order                              | Stops a user attaching another user's photo to their order                                           |

**A photo of a customer's home is PII.** Access is limited to the customer, the
assigned master, and admins — enforced server-side on every read.

## Provider — PENDING

| Provider             | For                                                                                                                      | Against                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Cloudflare R2**    | **No egress fees** — decisive, since every photo is read more than written; S3-compatible API; low latency to the region | Smaller ecosystem than AWS                                                                                      |
| **AWS S3**           | The reference implementation; every tool works with it                                                                   | Egress billed per GB, which is the dominant cost for a read-heavy image workload                                |
| **Backblaze B2**     | Cheapest storage; S3-compatible                                                                                          | Higher latency to the Caucasus; smaller ecosystem                                                               |
| **Supabase Storage** | Bundled auth and row-level policies                                                                                      | Only compelling if Supabase is adopted wholesale, which conflicts with [ADR-0003](ADR-0003-database-and-geo.md) |

### Recommendation

**Cloudflare R2.** The workload is write-once / read-many — every order photo is
viewed by the master, often the customer again, and sometimes an admin in a
dispute. Egress is therefore the dominant cost line, and R2 removes it entirely
while keeping the S3 API, so the decision stays reversible.

### What is needed to finalise

1. Confirmation from the user of an acceptable provider and account.
2. A data-residency check — whether Azerbaijani regulation constrains where
   customer-supplied images may be stored.

Until resolved, the storage client is written against the **S3 API** only, with
endpoint and credentials from configuration. No provider-specific SDK feature
may be used.
