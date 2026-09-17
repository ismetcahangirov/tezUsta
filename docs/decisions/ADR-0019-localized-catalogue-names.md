# ADR-0019 — Catalogue display names are a per-row locale map

- **Status:** **Accepted**
- **Date:** 2026-09-17
- **Decided by:** Project owner (language set), engineering (storage shape)

## Context

EPIC 3 / issue #31 required either multilingual name support in the service
catalogue schema, or an explicit recorded decision to defer it. Silence was not
an option.

"Languages at launch" is an open owner decision, listed as such in `CLAUDE.md`
§1: nobody can say today whether TezUsta ships `az` only, `az`+`ru`, or
`az`+`ru`+`en`. That decision needs the owner, not research, and this ADR does
not make it.

The catalogue itself is data, not code. `service_categories` and `services`
hold on the order of ten categories and thirty-five services, edited rarely and
read on nearly every screen. Adding a service or translating an existing one
must never require an app release or a schema migration — that is a technical
consideration EPIC 3 states directly, not a preference.

Primary market is Azerbaijan, Baku first (`CLAUDE.md` §1). `az` is not one
language among equals here; it is the language the product cannot ship without.

## Decision

**`service_categories.name` and `services.name` are `jsonb`, holding a map of
ISO 639-1 locale code to display string:**

```json
{ "az": "Santexnika", "en": "Plumbing" }
```

The TypeScript type is
`apps/api/src/common/i18n/localized-text.types.ts`:

```ts
export type LocalizedText = { readonly az: string } & Readonly<Record<string, string>>;
```

`az` is required, by the type **and** by a database CHECK constraint:

```sql
jsonb_typeof(name) = 'object'
  and jsonb_exists(name, 'az')
  and length(btrim(name ->> 'az')) > 0
```

All three functions — `jsonb_typeof`, `jsonb_exists`, `length`/`btrim` on the
extracted text — are verified `IMMUTABLE` in the running Postgres 17, which a
CHECK expression requires.

`az` is the fallback locale every read resolves to. Launch seed data carries
`az` and `en`. `ru` is not seeded — that is the owner's call to make later, and
making it is an admin edit to a row, not a migration.

The API resolves the caller's `Accept-Language` against the keys actually
present on the row, falling back to `az` when nothing else matches. There is no
hardcoded list of supported languages in the API — the data decides which
locales exist. That resolution step lands in issue #32; this ADR fixes the
storage shape it reads from.

## Why

**The open decision is exactly the reason not to encode an answer to it.** The
owner has not chosen a language set. A schema that assumes one — a column, a
fixed set of columns, a table keyed by a known locale list — is a bet on an
answer nobody has given. A `jsonb` map with one required key is the one shape
that is correct regardless of how "Languages at launch" resolves.

**The catalogue's own shape argues against a join.** Ten categories and
thirty-five services, read on nearly every screen, changed by an admin now and
then. That is a small, hot, low-churn table — the profile a denormalized
document column fits, not the profile a normalized child table fits.

**A CHECK constraint is the right amount of enforcement, not the most
available.** Postgres cannot type-check the inside of a `jsonb` document, so
the constraint is deliberately narrow: it proves the document is an object and
that `az` exists and is non-blank. It does not and cannot prove every value is
a sensible translation in the language its key claims — that is an editorial
concern, not a storage one, and belongs to whoever reviews the seed data and,
later, the admin panel.

## Alternatives considered

**A single `name text` column, defer multilingual entirely.** Rejected: when
the owner picks the language set, this costs a migration, a translations
table, an API response-shape change, and a mobile change, all at once and all
under launch pressure. Deferring the schema decision does not defer the cost —
it moves the cost to the day it is least convenient to pay it.

**A column per language (`name_az`, `name_ru`, `name_en`).** Rejected: every
new language becomes a migration and a schema change to a table an admin is
supposed to be able to edit freely. It also makes "which languages exist" a
property of the schema rather than of the data on the row, which is backwards
for a table whose entire job is to be edited without a release.

**A separate `service_name_translations` table, one row per locale.**
Rejected as premature for this shape of data: the catalogue is small and read
far more often than it is written, and every read would become a join plus a
pivot back into one object, bought for no present benefit. This is honestly
the right shape if translations ever need per-locale metadata of their own —
review status, translator, publication state — and that is recorded below as
the condition for revisiting this decision, not dismissed.

**Translate in the mobile app from a key.** Rejected outright, not weighed: it
makes adding a service require an app release, which is precisely what EPIC
3's technical considerations forbid. The catalogue would stop being data the
moment a new row needed a code change to be readable.

## Trade-offs accepted

- Postgres cannot type-check the inside of a `jsonb` document. The CHECK
  constraint covers the fallback key and that the document is an object; it
  does not and cannot prove every value is a sensible string in the language
  it claims to be.
- Querying "every row missing a Russian translation" is a `jsonb` expression
  (`not name ? 'ru'`), not `WHERE name_ru IS NULL`. Acceptable at this table's
  size — it is a full scan either way, and the table is small enough that the
  distinction is academic.
- Sorting the catalogue by translated name in the database is awkward, because
  the sort key depends on which locale is being served. It does not arise in
  practice: catalogue ordering is `display_order`, an explicit editorial
  choice, not an alphabetical one.

## Consequences

- `docs/architecture/database-architecture.md` § Conventions gains a line:
  localized display text is `jsonb` keyed by locale, with a required `az`
  fallback key enforced by a CHECK constraint.
- A future admin panel (EPIC 13) edits translations as fields on one row —
  adding a language is filling in a new key, not shipping a migration.
- The open `CLAUDE.md` §1 decision, "Languages at launch", is **not** closed by
  this ADR and remains the owner's to make. This ADR only makes the schema
  indifferent to the answer.

## Revisit when

Translations need per-locale workflow metadata — draft/published state, who
translated a value, when it was reviewed — or the catalogue grows past the
point where scanning `jsonb` to find untranslated rows is cheap. Either
condition is the signal to move to the `service_name_translations` table
considered and rejected above.
