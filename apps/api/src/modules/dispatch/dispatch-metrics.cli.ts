import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { loadAppConfig } from '../../infra/config/load-app-config';
import * as schema from '../../infra/database/schema';
import type { DispatchParameters } from './dispatch-metrics.format';
import { formatDispatchMetrics } from './dispatch-metrics.format';
import type { DispatchMetricsWindow } from './dispatch-metrics';
import { collectDispatchMetrics } from './dispatch-metrics';

/**
 * `pnpm --filter api dispatch:metrics` — the measurement ADR-0009 §Parameters
 * is waiting for, run against a real database (issue #114).
 *
 * **A CLI rather than an endpoint.** The alternative was an admin route, and
 * it would have cost an authenticated HTTP surface (ADR-0014) over
 * commercially sensitive data that says where masters stand, for a report run
 * by hand a handful of times in the life of the decision. There is no admin
 * panel yet and no reason for these numbers to be in a browser; a one-shot
 * process reachable only by somebody who already has the database URL is the
 * smaller thing to defend.
 *
 * It prints and exits. It writes nothing, and opens no transaction — every
 * statement it runs is a `SELECT`.
 *
 * ```
 * pnpm --filter api dispatch:metrics                 # the last 30 days
 * pnpm --filter api dispatch:metrics --days 7
 * pnpm --filter api dispatch:metrics --from 2026-10-01 --to 2026-11-01
 * pnpm --filter api dispatch:metrics --days 7 --json  # for a spreadsheet
 * ```
 */

/** The default window: long enough to hold a full week's rhythm, twice. */
const DEFAULT_WINDOW_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DispatchMetricsCliOptions {
  readonly window: DispatchMetricsWindow;
  readonly json: boolean;
}

/**
 * Turns `argv` into a window and an output format, or throws with a message
 * fit to print.
 *
 * Hand-parsed rather than validated with Zod, which CLAUDE.md §11 requires **at
 * the API boundary** — this is not one. An argv typo is made by the operator
 * standing at the terminal, who sees the error and retries; it is not an
 * untrusted value arriving over the network. What the rules below owe is a
 * clear message, and refusing a window that would silently measure nothing.
 *
 * Exported so the rules are testable without spawning a process.
 */
export function parseDispatchMetricsArgs(
  argv: readonly string[],
  now: Date = new Date(),
): DispatchMetricsCliOptions {
  let from: Date | null = null;
  let to: Date | null = null;
  let days: number | null = null;
  let json = false;

  const dateAt = (index: number, flag: string): Date => {
    const raw = argv[index];
    if (raw === undefined) {
      throw new Error(`${flag} needs a value`);
    }

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`${flag} is not a date this can read: ${raw}`);
    }

    return parsed;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    switch (flag) {
      case '--from':
        from = dateAt(index + 1, '--from');
        index += 1;
        break;
      case '--to':
        to = dateAt(index + 1, '--to');
        index += 1;
        break;
      case '--days': {
        const raw = argv[index + 1];
        const parsed = Number(raw);
        if (raw === undefined || !Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`--days needs a positive whole number of days, got: ${raw ?? '(none)'}`);
        }
        days = parsed;
        index += 1;
        break;
      }
      case '--json':
        json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag ?? ''}`);
    }
  }

  if (days !== null && (from !== null || to !== null)) {
    throw new Error('--days cannot be combined with --from or --to');
  }

  const end = to ?? now;
  const start = from ?? new Date(end.getTime() - (days ?? DEFAULT_WINDOW_DAYS) * MS_PER_DAY);

  if (start.getTime() >= end.getTime()) {
    throw new Error('The window is empty: --from must be strictly before --to');
  }

  return { window: { from: start, to: end }, json };
}

/**
 * Runs the report and returns what should be printed.
 *
 * Separate from the entrypoint below so an integration test can assert on the
 * text against a real database without a process exiting underneath it.
 */
export async function runDispatchMetrics(
  databaseUrl: string,
  parameters: DispatchParameters,
  options: DispatchMetricsCliOptions,
): Promise<string> {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const db = drizzle(pool, { schema });
    const report = await collectDispatchMetrics(db, options.window);

    return options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatDispatchMetrics(report, parameters);
  } finally {
    await pool.end();
  }
}

/**
 * CLI entrypoint: `node dist/modules/dispatch/dispatch-metrics.cli.js`.
 *
 * `require.main === module` rather than an `import.meta` check, for the reason
 * `migrate.ts` spells out: `tsconfig.build.json` emits CommonJS, so this
 * branch runs only when the file is executed directly and never when the two
 * functions above are imported by a test.
 */
if (require.main === module) {
  const config = loadAppConfig();

  const run = async (): Promise<void> => {
    const options = parseDispatchMetricsArgs(process.argv.slice(2));
    const output = await runDispatchMetrics(
      config.database.url,
      {
        initialRadiusM: config.dispatch.initialRadiusM,
        maxRadiusM: config.dispatch.maxRadiusM,
        radiusStepSeconds: config.dispatch.radiusStepSeconds,
        totalTimeoutSeconds: config.dispatch.totalTimeoutSeconds,
        maxMastersPerBroadcast: config.dispatch.maxMastersPerBroadcast,
      },
      options,
    );

    process.stdout.write(output);
  };

  run()
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error('Dispatch metrics failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
