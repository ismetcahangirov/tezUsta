/**
 * Barrel for every Drizzle table definition. `drizzle.config.ts` points
 * `schema` here, and `DatabaseModule` passes this whole module to `drizzle()`
 * so relational queries can resolve every table.
 *
 * EPIC 2 (issue #25) adds the first tables: identity (`users`, `user_roles`)
 * and the device sessions that back the token model (`sessions`,
 * `refresh_tokens`); issue #29 adds `otp_challenges`, the credential those
 * sessions are opened against. EPIC 3 (issue #31) adds the catalogue an order
 * will reference — `service_categories` and `services`. EPIC 4 (issue #34)
 * adds `customers`, the first **role profile** hanging off an account rather
 * than replacing it, and (issue #35) `addresses`, the first table in the
 * schema to carry a PostGIS geometry, plus `geocode_cache` (issue #36), which is
 * infrastructure rather than domain: it holds nothing but coordinates, for no
 * longer than the maps licence allows. Everything else in
 * `docs/architecture/database-architecture.md` § Entity model is still a
 * starting point for domain analysis, not a schema to implement ahead of the
 * Epic that needs it. EPIC 5 (issue #37) adds `masters` — the second role
 * profile — and `master_services`, the first table whose rows carry a price a
 * master owns rather than the platform (ADR-0010). Issue #38 adds
 * `master_documents` and the append-only `master_verification_history` — the
 * trust gate's evidence and its audit trail (ADR-0023, ADR-0024). Issue #39
 * adds the admin account store ADR-0014 assigned to EPIC 2 and EPIC 2 never
 * shipped — `admin_users`, `admin_sessions` and the append-only
 * `admin_audit_log` — plus the reviewer columns that hang off them. EPIC 6
 * (issue #80) adds `orders` — the row the whole product exists to create —
 * and the append-only `order_status_history` behind it (ADR-0015, ADR-0013).
 * Issue #83 adds `order_photos`, the customer's problem-photo evidence, on
 * the exact upload mechanism issue #38 built.
 */
export * from './users';
export * from './sessions';
export * from './otp-challenges';
export * from './service-categories';
export * from './services';
export * from './customers';
export * from './addresses';
export * from './geocode-cache';
export * from './masters';
export * from './admin';
export * from './master-verification';
export * from './orders';
export * from './order-photos';
