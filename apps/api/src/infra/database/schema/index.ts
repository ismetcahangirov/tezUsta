/**
 * Barrel for every Drizzle table definition. `drizzle.config.ts` points
 * `schema` here, and `DatabaseModule` passes this whole module to `drizzle()`
 * so relational queries can resolve every table.
 *
 * EPIC 2 (issue #25) adds the first tables: identity (`users`, `user_roles`)
 * and the device sessions that back the token model (`sessions`,
 * `refresh_tokens`); issue #29 adds `otp_challenges`, the credential those
 * sessions are opened against. Everything else in
 * `docs/architecture/database-architecture.md` § Entity model is still a
 * starting point for domain analysis, not a schema to implement ahead of the
 * Epic that needs it.
 */
export * from './users';
export * from './sessions';
export * from './otp-challenges';
