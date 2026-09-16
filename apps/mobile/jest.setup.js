// `EXPO_PUBLIC_API_URL` is inlined by Metro at build time and read once, at
// module scope, by `src/api/base-query.ts`. Jest does not run Metro and does
// not load `.env`, so without a value here every request would be built
// against a relative URL — and `new Request('/auth/refresh')` throws in Node,
// which fails a suite for a reason that has nothing to do with what it tests.
//
// Set unconditionally so a value exported in a developer's shell cannot make
// the suite behave differently on their machine than in CI.
process.env.EXPO_PUBLIC_API_URL = 'http://api.test';
