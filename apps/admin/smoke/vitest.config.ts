import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The proxy smoke test (#331): Node, not jsdom, real network, and nothing from
 * the unit suite. Run with `pnpm --filter admin test:smoke`.
 */
export default defineConfig({
  // The panel's directory, wherever the command is run from.
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['smoke/**/*.smoke.test.ts'],
    testTimeout: 30_000,
  },
});
