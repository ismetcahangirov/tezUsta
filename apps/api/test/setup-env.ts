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
