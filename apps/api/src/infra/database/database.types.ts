import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import type * as schema from './schema';

/**
 * The Drizzle client `DatabaseModule` provides under {@link DATABASE_CONNECTION}.
 *
 * Spelled out rather than using the bare `NodePgDatabase<typeof schema>` that
 * `drizzle-orm/node-postgres` exports: `drizzle(pool, …)` actually returns
 * `NodePgDatabase<TSchema> & { $client: Pool }`, and the standalone type drops
 * that intersection member — which is the one `DatabaseModule.onModuleDestroy`
 * needs in order to close the pool.
 *
 * Lives in its own file so a repository can import the type without importing
 * `DatabaseModule` itself, which would create a module-to-module edge that
 * `no-circular` would eventually trip over.
 */
export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

/**
 * The handle Drizzle hands a `db.transaction(async (tx) => …)` callback.
 *
 * Derived from {@link Database} rather than assembled from the four generic
 * parameters `PgTransaction` takes, because those parameters are an
 * implementation detail of the driver package: spelling them out here would
 * mean a `drizzle-orm` upgrade that reorders them breaks a type in a file that
 * has nothing to do with the change.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Either a connection or an open transaction — the parameter type of a
 * repository method that must be able to **join a caller's transaction**
 * rather than open its own.
 *
 * This is what lets a module keep owning its tables while another module
 * composes an atomic write across both: `CustomersRepository` opens one
 * transaction and hands it to `UsersRepository.grantRole`, so the profile row
 * and the role grant commit together. The alternative — reaching into another
 * module's table from this one's repository — would put the same SQL in two
 * places and make "who owns `user_roles`?" unanswerable
 * (`docs/architecture/backend-architecture.md` § Module rules).
 */
export type DatabaseExecutor = Database | Transaction;
