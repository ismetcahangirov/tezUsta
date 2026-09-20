import { randomUUID } from 'node:crypto';

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
// It is **generated per test file**, which is the fix for issue #108. The
// value used to be a constant, under a comment claiming it namespaced this
// run's Redis keys — and it did not: an HMAC pepper only namespaces anything
// if it differs, and a literal is the same in every checkout, every run and
// every file. Every rate-limit window is an hour
// (`infra/rate-limit/rate-limit.config.ts`), so the budgets did not reset
// between runs; they accumulated until they were spent and then every
// subsequent run failed with 429s that had nothing to do with the code under
// test. That is what it namespaces now, for real.
//
// **Per file, not merely per process.** Vitest reuses a worker process across
// test files, and `process.env` survives that reuse, so a plain `??=` would
// hand the second and third file in a worker the first one's budget — the same
// bug at a smaller radius. `setupFiles` runs once per test file with a fresh
// module graph, so regenerating here gives each file a budget nothing else
// shares. The marker below is what makes "regenerate" safe: without it there
// is no way to tell a value this file wrote a moment ago from one CI or a
// developer set deliberately, and clobbering the latter would take the pin
// away that `??=` exists to respect everywhere else in this file.
//
// Nothing needs sweeping afterwards: every key this writes is a `rl:v1:*`
// counter whose TTL is its own one-hour window, so an abandoned run's keys
// expire on their own.
const GENERATED_RATE_LIMIT_SECRET_MARKER = 'TEZUSTA_TEST_GENERATED_RATE_LIMIT_SECRET';
if (
  process.env.RATE_LIMIT_KEY_SECRET === undefined ||
  process.env[GENERATED_RATE_LIMIT_SECRET_MARKER] === 'true'
) {
  process.env.RATE_LIMIT_KEY_SECRET = `test-only-rate-limit-pepper-${randomUUID()}`;
  process.env[GENERATED_RATE_LIMIT_SECRET_MARKER] = 'true';
}

// Issue #29 adds a fourth: `OtpModule` refuses to start without the pepper
// every OTP code is HMAC'd under before it reaches a database row. Distinct
// from the three above for the reason `env.schema.ts` enforces — a pepper that
// doubles as a signing key cannot be rotated when a dump is suspected.
process.env.OTP_CODE_PEPPER ??= 'test-only-otp-pepper-mnbvcxzlkjhgfdsapoiuytrewq';

// Issue #39 adds a fifth: `AdminModule` refuses to start without the key the
// admin token family is signed with. Distinct from all four above, because
// `env.schema.ts` rejects a secret shared with any of them — the admin key
// signs tokens that suspend masters and read personal data across the
// platform, and sharing it would make a consumer-side signing bug an admin
// compromise.
process.env.JWT_ADMIN_ACCESS_SECRET ??= 'test-only-admin-secret-plokmijnuhbygvtfcrdxeszwaq';

// Issue #102 adds a namespace rather than a secret. Every BullMQ key is
// written under `QUEUE_PREFIX`, and Redis is shared: two checkouts, or a CI
// job and a developer's `pnpm test`, point at the same container. With a
// constant prefix one run's worker would happily consume the other run's
// delayed jobs — a failure that reads as a flaky test and is actually
// cross-talk, which is the problem `RATE_LIMIT_KEY_SECRET` solves for the rate
// limiter by being a pepper.
//
// The pid is what makes it per-run rather than merely per-repository. Vitest
// gives each test file a worker process, so this is stable within a file (the
// app may boot several times inside one suite and must find its own jobs) and
// distinct across concurrent runs. Hyphens only — `env.schema.ts` restricts
// the prefix to `[A-Za-z0-9_-]{1,32}` because the value is concatenated into
// every key.
process.env.QUEUE_PREFIX ??= `test-${String(process.pid)}`;

// Issue #125 adds the other half of the same namespace. `QUEUE_PREFIX` covers
// the keys BullMQ writes; this covers the keys the application writes itself —
// presence (`<prefix>:presence:master:<id>`) and the catalogue cache. Without
// it those two keyspaces were shared by every run in every checkout, which is
// why `nearby-masters.integration.test.ts` used to delete its seeded presence
// keys one id at a time: a `presence:master:*` glob would have taken
// `master-availability.e2e`'s and `master-location.e2e`'s with it, and the
// symptom read as a presence bug in a file that did nothing wrong.
//
// **Per file, not per pid** — the distinction `RATE_LIMIT_KEY_SECRET` makes
// above and `QUEUE_PREFIX` does not. Vitest reuses a worker process across
// test files, so a pid-derived value is shared by every file that worker runs,
// and the three suites named above seed overlapping master ids. A queue job is
// addressed by an id this run minted, so sharing a prefix across files in one
// process is harmless there; a presence key is addressed by a master id that
// two files can both choose, so it is not harmless here.
//
// Nothing needs sweeping afterwards: every key written under this prefix
// carries a TTL of its own — presence expires at `PRESENCE_TTL_SECONDS`, and
// `CacheService` never writes without `EX` — so an abandoned run's namespace
// empties itself.
const GENERATED_REDIS_KEY_PREFIX_MARKER = 'TEZUSTA_TEST_GENERATED_REDIS_KEY_PREFIX';
if (
  process.env.REDIS_KEY_PREFIX === undefined ||
  process.env[GENERATED_REDIS_KEY_PREFIX_MARKER] === 'true'
) {
  // `env.schema.ts` restricts the prefix to `[A-Za-z0-9_-]{1,32}`, so the
  // UUID's hyphens are dropped and it is truncated well inside that bound.
  process.env.REDIS_KEY_PREFIX = `test-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  process.env[GENERATED_REDIS_KEY_PREFIX_MARKER] = 'true';
}

// Issue #57/#69/#92 add the retention sweeps, on a BullMQ job scheduler.
// Disabled for the suites, and deliberately: a sweep running in the
// background while a test asserts on rows either side of a retention cutoff
// is a flake whose cause would take an afternoon to find. The sweeps have
// their own suite, which sets a real interval — or invokes the job directly —
// on purpose.
process.env.MAINTENANCE_SWEEP_INTERVAL_MINUTES ??= '0';
