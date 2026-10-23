import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The proxy smoke test (ADR-0061, mirroring #331): Node, not jsdom, real network, and nothing from
 * the unit suite. Run with `pnpm --filter web test:smoke`.
 */
export default defineConfig({
  // The page's directory, wherever the command is run from.
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['smoke/**/*.smoke.test.ts'],
    testTimeout: 30_000,
  },
});
