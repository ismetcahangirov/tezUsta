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
