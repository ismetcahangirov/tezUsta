import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The page is a public bundle (ADR-0061, as ADR-0052 says of the admin
 * panel): anything Vite inlines into it is readable by whoever loads it. So it reads **no** build-time
 * variable at all — no `import.meta.env.VITE_*`, no `envPrefix` widened to
 * pull in others — and this test fails the build the day one appears. A
 * value the page genuinely needs at runtime comes from the API, behind a
 * session, never from the bundle.
 */
const ROOT = path.resolve(__dirname, '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe('no build-time secret can reach the page bundle', () => {
  it('reads no Vite environment variable anywhere in its source', () => {
    const offenders = sourceFiles(path.join(ROOT, 'src')).filter((file) =>
      /import\.meta\.env\b|\bVITE_[A-Z0-9_]+/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('replaces no variable into index.html either', () => {
    expect(readFileSync(path.join(ROOT, 'index.html'), 'utf8')).not.toMatch(/%[A-Z0-9_]+%/);
  });

  it('keeps Vite’s default env prefix, so no other variable is exposed either', () => {
    const config = readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).not.toMatch(/envPrefix|define\s*:/);
  });
});
