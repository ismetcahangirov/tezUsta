import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { loadAppConfig } from '../../infra/config/load-app-config';
import type { Database } from '../../infra/database/database.types';
import * as schema from '../../infra/database/schema';
import type { AdminAuthConfig } from './admin.config';
import { createAdminAuthConfig } from './admin.config';
import { AdminRepository } from './admin.repository';
import { AdminSetupService } from './admin-setup.service';

/**
 * `admin:bootstrap` (ADR-0043 § 3) — the one way into the admin panel that
 * does not go through the panel.
 *
 * - `--email <e> --name <n>` creates the **first** `super_admin` and prints a
 *   setup link. Refused if an active `super_admin` already exists: after the
 *   first, admins are invited from the panel, where the invitation is
 *   audited against the admin who made it.
 * - `--reissue <email>` clears an existing `super_admin`'s password and
 *   second factor, ends their sessions and prints a new link — the recovery
 *   path for a `super_admin` with nobody left to reset them.
 *
 * Server access is the credential. The link is printed once and never stored.
 */
export type AdminBootstrapOptions =
  | { readonly mode: 'create'; readonly email: string; readonly displayName: string }
  | { readonly mode: 'reissue'; readonly email: string };

export class AdminBootstrapRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminBootstrapRefusedError';
    Object.setPrototypeOf(this, AdminBootstrapRefusedError.prototype);
  }
}

export function parseAdminBootstrapArgs(argv: readonly string[]): AdminBootstrapOptions {
  let email: string | undefined;
  let name: string | undefined;
  let reissue: string | undefined;

  const valueAt = (index: number, flag: string): string => {
    const raw = argv[index];
    if (raw === undefined || raw.startsWith('--') || raw.trim().length === 0) {
      throw new Error(`${flag} needs a value`);
    }
    return raw.trim();
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--email':
        email = valueAt(index + 1, '--email');
        index += 1;
        break;
      case '--name':
        name = valueAt(index + 1, '--name');
        index += 1;
        break;
      case '--reissue':
        reissue = valueAt(index + 1, '--reissue');
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${flag ?? ''}`);
    }
  }

  if (reissue !== undefined) {
    if (email !== undefined || name !== undefined) {
      throw new Error('--reissue cannot be combined with --email or --name');
    }
    return { mode: 'reissue', email: reissue };
  }
  if (email === undefined || name === undefined) {
    throw new Error(
      'Usage: admin:bootstrap --email <email> --name <display name> | --reissue <email>',
    );
  }
  return { mode: 'create', email, displayName: name };
}

/**
 * Does the work and returns the text to print. Separate from the entrypoint so
 * an integration test can run it against a real database.
 */
export async function runAdminBootstrap(
  databaseUrl: string,
  config: AdminAuthConfig,
  options: AdminBootstrapOptions,
  now: Date = new Date(),
): Promise<string> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const db: Database = drizzle(pool, { schema });
    const admins = new AdminRepository(db);
    const setup = new AdminSetupService(admins, config);

    const issued = await admins.transaction(async (tx) => {
      // Two bootstraps at once would each see no super_admin and each create
      // one. A transaction-scoped advisory lock makes them take turns.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tezusta:admin-bootstrap'))`);

      if (options.mode === 'create') {
        if ((await admins.countActiveSuperAdmins(tx)) > 0) {
          throw new AdminBootstrapRefusedError(
            'An active super_admin already exists. Invite further admins from the panel, or ' +
              'recover a super_admin with --reissue <email>.',
          );
        }
        const admin = await admins.createAdmin(
          { email: options.email, displayName: options.displayName, roles: ['super_admin'] },
          tx,
        );
        await admins.appendAudit(
          {
            adminUserId: admin.id,
            action: 'admin.bootstrap',
            targetType: 'admin_user',
            targetId: admin.id,
          },
          now,
          tx,
        );
        return setup.issueInvitation(admin.id, null, now, tx);
      }

      const admin = await admins.findLiveAdminByEmail(options.email);
      const roles = admin === undefined ? [] : await admins.findRoles(admin.id);
      if (admin === undefined || admin.status !== 'active' || !roles.includes('super_admin')) {
        throw new AdminBootstrapRefusedError(
          '--reissue works only for an active super_admin. Other admins are reset from the panel.',
        );
      }
      await admins.clearCredentials(admin.id, now, tx);
      await admins.appendAudit(
        {
          adminUserId: admin.id,
          action: 'admin.bootstrap.reissue',
          targetType: 'admin_user',
          targetId: admin.id,
        },
        now,
        tx,
      );
      return setup.issueInvitation(admin.id, null, now, tx);
    });

    return (
      `Setup link (single use, valid until ${issued.expiresAt.toISOString()}):\n` +
      `${issued.link}\n` +
      'Hand it over out of band. It is not stored and will not be shown again.\n'
    );
  } finally {
    await pool.end();
  }
}

/**
 * CLI entrypoint: `node dist/modules/admin/admin-bootstrap.cli.js`, wrapped as
 * `pnpm --filter api admin:bootstrap`. `require.main === module` for the
 * reason `dispatch-metrics.cli.ts` gives.
 */
if (require.main === module) {
  const appConfig = loadAppConfig();

  const run = async (): Promise<void> => {
    const options = parseAdminBootstrapArgs(process.argv.slice(2));
    process.stdout.write(
      await runAdminBootstrap(appConfig.database.url, createAdminAuthConfig(appConfig), options),
    );
  };

  run().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
