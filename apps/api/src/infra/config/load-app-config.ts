import type { AppConfig } from './app-config.types';
import { loadEnvFileIfPresent } from './load-env-file';
import { parseEnv } from './parse-env';

/**
 * Loads `.env` (local dev only — see `loadEnvFileIfPresent`) and returns the
 * validated {@link AppConfig}, for the one caller that needs configuration
 * OUTSIDE Nest's DI graph: `infra/database/migrate.ts`'s CLI entrypoint,
 * which runs as its own one-shot process with no `APP_CONFIG` provider to
 * inject.
 *
 * Keeping this here — instead of letting `migrate.ts` call
 * `parseEnv(process.env)` itself — is what keeps `process.env` confined to
 * `src/infra/config/` with no exception: `grep -rn "process\.env" apps/api/src`
 * must find it nowhere else (`docs/engineering/security.md` § Environment
 * validation).
 */
export function loadAppConfig(): AppConfig {
  loadEnvFileIfPresent();
  return parseEnv(process.env);
}
