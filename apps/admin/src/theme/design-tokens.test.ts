// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import adminTokens from './design-tokens.json';

/**
 * The admin panel's tokens are a copy of the mobile app's, because an app may
 * not import another app (.dependency-cruiser.cjs). This test is what keeps
 * the copy honest until the tokens move into a shared package: change a value
 * on one side only and the build fails here. Read from disk, not imported, so
 * it creates no module edge between the two apps.
 */
const MOBILE_TOKENS = fileURLToPath(
  new URL('../../../mobile/src/theme/design-tokens.json', import.meta.url),
);

interface MobileTokens {
  color: unknown;
  space: unknown;
  radius: unknown;
  size: unknown;
  typography: { scale: unknown };
}

describe('design tokens', () => {
  const mobile = JSON.parse(readFileSync(MOBILE_TOKENS, 'utf8')) as MobileTokens;

  it.each(['color', 'space', 'radius', 'size'] as const)('%s matches apps/mobile', (group) => {
    expect(adminTokens[group]).toEqual(mobile[group]);
  });

  it('the type scale matches apps/mobile', () => {
    expect(adminTokens.typography.scale).toEqual(mobile.typography.scale);
  });
});
