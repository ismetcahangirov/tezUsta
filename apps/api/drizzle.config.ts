import { defineConfig } from 'drizzle-kit';

import { loadEnvFileIfPresent } from './src/infra/config/load-env-file';
import { parseEnv } from './src/infra/config/parse-env';

// Tooling config, not application source: dependency-cruiser's tooling
// allow-list (`.dependency-cruiser.cjs` `not-to-dev-dep`, matched by this
// file's own `(^|/)drizzle\.config\.(js|cjs|mjs|ts)$` pattern) lets it import
// `drizzle-kit`, a devDependency, which application code under `src/` may not.
//
// Sources `DATABASE_URL` through the SAME parser the app uses at runtime
// (issue #23's whole point — one schema, one reader of `process.env`) instead
// of reading `process.env.DATABASE_URL` here directly. `loadEnvFileIfPresent`
// picks up a local `.env` for `drizzle-kit`'s own CLI use; `parseEnv` is what
// actually validates the value.
loadEnvFileIfPresent();
const config = parseEnv(process.env);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infra/database/schema/index.ts',
  out: './src/infra/database/migrations',
  dbCredentials: {
    url: config.database.url,
  },
});
