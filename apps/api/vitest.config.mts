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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      // Coverage is a diagnostic, not a target — no thresholds here.
    },
  },
});
