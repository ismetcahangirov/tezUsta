// Every integration test that instantiates `AppModule` pulls in the global
// `ConfigModule` (issue #23), which validates `DATABASE_URL`/`REDIS_URL` at
// module-instantiation time — fail fast is the point of that module. CI sets
// both for the whole job (`.github/workflows/ci.yml`); this fills in
// well-formed local fallbacks so `pnpm test` also passes on a fresh checkout
// with no `.env` and no database running. `??=` never overrides a value the
// environment already provided, and nothing under test opens a real
// connection with these — they only need to satisfy the config schema's URL
// shape check.
process.env.DATABASE_URL ??= 'postgresql://tezusta:tezusta@localhost:15432/tezusta';
process.env.REDIS_URL ??= 'redis://localhost:6379';
