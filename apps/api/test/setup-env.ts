// Every integration test that instantiates `AppModule` pulls in the global
// `ConfigModule` (issue #23), which validates `DATABASE_URL`/`REDIS_URL` at
// module-instantiation time — fail fast is the point of that module. CI sets
// both for the whole job (`.github/workflows/ci.yml`); this fills in the local
// dev-stack defaults so `pnpm test` also works on a fresh checkout with no
// `.env`. `??=` never overrides a value the environment already provided.
//
// These are real endpoints, not placeholders: the integration suites DO
// connect through them (`database.migrations`, `database.geometry`,
// `database.readiness`, `infra-resilience`, and `health.e2e`, which asserts
// postgres and redis are up). `docker compose up -d` must be running, and the
// port is 15432 because a native Postgres install commonly owns 5432.
process.env.DATABASE_URL ??= 'postgresql://tezusta:tezusta@localhost:15432/tezusta';
process.env.REDIS_URL ??= 'redis://localhost:6379';

// EPIC 2 makes the two JWT secrets load-bearing: `AuthModule` refuses to
// start without them (`docs/architecture/authentication.md`), so every
// integration test that instantiates `AppModule` needs a pair. These are
// test-only values, never used anywhere else, and they are deliberately
// DIFFERENT from each other — `env.schema.ts` rejects a shared secret, and a
// test that accidentally passed the same string twice would be asserting
// against a configuration the application refuses to boot with.
process.env.JWT_ACCESS_SECRET ??= 'test-only-access-secret-0123456789abcdefghijklmnop';
process.env.JWT_REFRESH_SECRET ??= 'test-only-refresh-secret-zyxwvutsrqponmlkjihgfedcba';
