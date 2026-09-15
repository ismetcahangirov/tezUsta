/**
 * Barrel for every Drizzle table definition. `drizzle.config.ts` points
 * `schema` here, and `DatabaseModule` passes this whole module to `drizzle()`
 * so relational queries can resolve every table.
 *
 * Deliberately empty today: EPIC 1 (this issue, #22) sets up the database
 * connection, migration pipeline, and PostGIS extension only — it creates no
 * business tables (CLAUDE.md §2: "Packages [and modules] are created when a
 * second consumer exists / when needed, not before"). The entity model in
 * `docs/architecture/database-architecture.md` is a starting point for
 * domain analysis, not a schema to implement here.
 *
 * The first table (most likely `users`, per that document's entity model)
 * arrives with EPIC 2 (authentication) or EPIC 6 (masters), whichever lands
 * first — export it from its own file in this directory and re-export it
 * below.
 */
export {};
