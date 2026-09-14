---
name: security-review
description: Use before merging any change that touches authentication, authorization, user input, uploads, location data, PII, logging, or a new endpoint. Triggers on "security review", "is this safe", "auth change", "new endpoint", "file upload", or before opening a PR on sensitive code.
---

# Security review

TezUsta sends a stranger to someone's home and moves money. A failure here has
physical consequences, not just financial ones.

Reference: `docs/engineering/security.md`.

## The five questions that catch most real problems

### 1. Can this endpoint return another user's data?

The most common real vulnerability in a marketplace. An authenticated user is
**not** thereby entitled to an arbitrary id.

```ts
// ❌ authenticated, but not authorized
const order = await this.repo.findById(id);
return order;

// ✅ ownership checked
const order = await this.repo.findById(id);
if (!order) throw new NotFoundError();
if (!canView(actor, order)) throw new NotFoundError(); // 404, not 403
```

**Return 404, not 403.** A 403 on someone else's id confirms it exists, turning
the endpoint into an enumeration oracle.

### 2. Is the role check reading the token, or the database?

```ts
// ❌ a token issued before suspension still says role: master
if (actor.role !== 'master') throw new ForbiddenError();

// ✅ current truth
const master = await this.masters.findByUserId(actor.id);
if (!master || master.verificationStatus !== 'verified' || master.suspendedAt) {
  throw new ForbiddenError();
}
```

**A role claim is a cache, not an authority.** This is the difference between a
master being suspended and a master actually being unable to accept work.

### 3. Is every input validated, server-side?

- Zod at the boundary, including **WebSocket payloads**
- `.strict()` to reject unknown fields (mass assignment)
- Bound every string, array, and number — an unbounded text field is a DoS vector
- Validate path and query params, not just bodies
- Ranges as well as types: a 10,000 km radius is well-typed and wrong

### 4. Does anything sensitive reach a log or an error response?

**Never logged:** tokens, refresh tokens, OTP codes, passwords, full phone
numbers, precise coordinates, payment details, full addresses.

**Never returned to a client:** stack traces, SQL, driver errors, infrastructure
detail. The global filter maps unknown errors to a generic 500 and logs the
detail with the `requestId`.

### 5. Is this endpoint abusable, and is it rate limited?

| Surface         | The real risk                                             |
| --------------- | --------------------------------------------------------- |
| OTP request     | **A cost attack** — the attacker spends your money on SMS |
| Sign-in         | Credential stuffing                                       |
| Order creation  | Spam orders wasting master time                           |
| Location ingest | Resource exhaustion                                       |
| Reviews         | Reputation manipulation                                   |

Rate-limit state lives in **Redis**, never in process memory — an in-process
counter is per-instance (so N× weaker than intended) and resets on deploy.

## Location and PII — TezUsta-specific

| Rule                   |                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------- |
| Live master position   | Visible **only** to the customer on the **active** order, **only** while active |
| Customer exact address | Revealed to a master **only after acceptance**                                  |
| Location history       | Retention-bounded, aged out on a schedule                                       |
| Problem photos         | Private bucket; customer, assigned master, admins only                          |
| Coordinates            | **Never** in logs or traces                                                     |

**Why the address rule matters:** broadcasting exact addresses to every nearby
master on every order leaks the home addresses of people who never became
customers.

## File upload

- Presigned URL, short-lived, single-use
- Content-type **allow-list** (allow-lists fail closed; deny-lists do not)
- Size cap **in the presign policy**, not checked afterwards — by then the upload
  happened
- **Validate the actual leading bytes**, not the declared `Content-Type` — a
  declared type is a client assertion
- Server-generated UUID keys, never client filenames (path traversal)
- Photo keys bound to the issuing user and order

## Secrets

- Nothing secret behind **`EXPO_PUBLIC_`** — that prefix ships in the app bundle
- New env vars go in `.env.example` as **placeholders only**
- **If a secret was ever committed, rotate it.** The repository is public;
  removing it from history does not un-leak it

## Checklist before merging

- [ ] Every new input validated server-side
- [ ] Authorization checked server-side, **including ownership**
- [ ] No endpoint leaks another user's data via an id
- [ ] Role/status re-checked against the database, not the token
- [ ] No sensitive data in logs or error responses
- [ ] New abusable endpoints are rate limited
- [ ] Uploads validated by actual bytes, not declared type
- [ ] Nothing secret behind `EXPO_PUBLIC_`
- [ ] **Tests cover the unauthorized paths**, not just the happy one

## Reporting

Do **not** open a public issue — the repository is public and an issue is a
disclosure. Contact the owner directly.
