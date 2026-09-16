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

// Issue #28 adds a third: `RateLimitModule` refuses to start without the
// pepper it hashes phone numbers and IPs under, so every integration test
// that instantiates `AppModule` needs one. Distinct from the two above —
// `env.schema.ts` rejects a pepper that equals either JWT secret.
//
// It also namespaces this suite's Redis keys for free: the key is an HMAC
// under this value, so a test run here cannot collide with anything another
// checkout is doing against the same shared Redis container.
process.env.RATE_LIMIT_KEY_SECRET ??= 'test-only-rate-limit-pepper-qwertyuiopasdfghjklzxcvb';
