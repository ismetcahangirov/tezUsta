import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { loadAppConfig } from '../../infra/config/load-app-config';
import * as schema from '../../infra/database/schema';
import type { DispatchMetricsCliOptions } from '../dispatch/dispatch-metrics.cli';
import { parseDispatchMetricsArgs } from '../dispatch/dispatch-metrics.cli';
import { collectArrivalMetrics } from './arrival-metrics';
import { formatArrivalMetrics } from './arrival-metrics.format';

/**
 * `pnpm --filter api arrival:metrics` — how arrival promises were kept, and
 * the data that replaces the fallback estimate's two guesses (issue #410,
 * ADR-0055 § 10).
 *
 * A CLI, for `dispatch:metrics`' reasons: commercially sensitive numbers, run
 * by hand a handful of times, by somebody who already has the database URL. It
 * prints and exits, and every statement it runs is a `SELECT`. The arguments
 * are `dispatch:metrics`' own, parsed by the same function:
 *
 * ```
 * pnpm --filter api arrival:metrics                 # the last 30 days
 * pnpm --filter api arrival:metrics --days 7
 * pnpm --filter api arrival:metrics --from 2026-11-01 --to 2026-12-01
 * pnpm --filter api arrival:metrics --json          # for a spreadsheet
 * ```
 */
export async function runArrivalMetrics(
  databaseUrl: string,
  options: DispatchMetricsCliOptions,
): Promise<string> {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const db = drizzle(pool, { schema });
    const report = await collectArrivalMetrics(db, options.window);

    return options.json ? `${JSON.stringify(report, null, 2)}\n` : formatArrivalMetrics(report);
  } finally {
    await pool.end();
  }
}

/** CLI entrypoint, `node dist/modules/arrival-promise/arrival-metrics.cli.js`; see `migrate.ts`. */
if (require.main === module) {
  const config = loadAppConfig();

  // Parsed inside the chain, so a bad argument is reported like any other
  // failure — one line, no stack trace.
  Promise.resolve()
    .then(() =>
      runArrivalMetrics(config.database.url, parseDispatchMetricsArgs(process.argv.slice(2))),
    )
    .then((output) => {
      process.stdout.write(output);
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error('Arrival metrics failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
