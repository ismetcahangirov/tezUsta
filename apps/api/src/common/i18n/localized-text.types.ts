/**
 * A catalogue string in every language it has been translated into, keyed by
 * ISO 639-1 code: `{ az: 'Santexnika', en: 'Plumbing' }`.
 *
 * **Why a per-row map rather than a translations table**
 * ([ADR-0019](docs/decisions/ADR-0019-localized-catalogue-names.md)): which
 * languages TezUsta ships at launch is an open owner decision (CLAUDE.md §1).
 * A shape that hardcodes the answer — one `name` column, or a column per
 * language — turns that decision into a migration plus an API change. A map
 * keyed by locale turns it into a new key in a row an admin can edit, which
 * is what "the catalogue is data, not code" means.
 *
 * `az` is required by the type **and** by a database CHECK constraint. It is
 * the fallback every read resolves to, so a row without it would render as
 * nothing at all in the app — and a constraint that only the application
 * enforces is a constraint that the seed script, a migration, and a future
 * admin panel each get a separate chance to break.
 */
export type LocalizedText = { readonly az: string } & Readonly<Record<string, string>>;

/**
 * The locale every catalogue read falls back to when the caller asks for a
 * language a row has not been translated into. Azerbaijani, because the market
 * is Azerbaijan (CLAUDE.md §1) — not because the launch language set is
 * settled, which it is not.
 */
export const FALLBACK_LOCALE = 'az';
