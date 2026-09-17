import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is mandatory here, not a style choice: Vitest otherwise transforms TS
// with esbuild/oxc, neither of which emits `design:paramtypes`, so Nest's
// constructor injection has no metadata to read and `Test.createTestingModule`
// fails for any provider with a constructor dependency.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Provides DATABASE_URL/REDIS_URL fallbacks so integration tests that
    // instantiate AppModule (and so the global ConfigModule) can compile
    // without a real .env or database — see test/setup-env.ts.
    setupFiles: ['./test/setup-env.ts'],
    // Vitest's default hook timeout is 10s, and almost every suite under
    // `test/` spends its `beforeAll` doing the same three things: CREATE
    // DATABASE on the shared Postgres, run every migration into it, and boot
    // the full Nest graph. That is comfortably under 10s on an idle machine
    // and not under `pnpm verify`, where the mobile Jest run is saturating the
    // CPU alongside it — and it gets slower with every migration the project
    // adds, so the failure arrives as an unrelated-looking flake in whichever
    // suite happened to be scheduled last.
    //
    // Raised here rather than repeated as `}, 60_000)` on fourteen hooks: the
    // cost only ever applies to a hook that actually hangs, and a per-file
    // number is one more thing to remember when the next integration suite is
    // written. Individual `it()` timeouts are untouched — a slow assertion is
    // still a failure.
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      // Coverage is a diagnostic, not a target — no thresholds here.
    },
  },
});
