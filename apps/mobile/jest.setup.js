// `EXPO_PUBLIC_API_URL` is inlined by Metro at build time and read once, at
// module scope, by `src/api/base-query.ts`. Jest does not run Metro and does
// not load `.env`, so without a value here every request would be built
// against a relative URL — and `new Request('/auth/refresh')` throws in Node,
// which fails a suite for a reason that has nothing to do with what it tests.
//
// Set unconditionally so a value exported in a developer's shell cannot make
// the suite behave differently on their machine than in CI.
process.env.EXPO_PUBLIC_API_URL = 'http://api.test';

// The map is a native view with nothing to draw into under Jest (issue #172).
// `src/tracking/map-surface.tsx` is the only file that imports
// `react-native-maps`, so replacing that one module here keeps every suite
// that renders an order screen off the native module without each of them
// having to know the map exists. `map-surface.test.tsx` opts back out to test
// the adapter itself against a stubbed vendor module.
jest.mock('./src/tracking/map-surface', () => require('./test/support/fake-map-surface'));
