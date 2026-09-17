import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The executable form of issue #36's own acceptance criterion: "Grep confirms
 * no vendor SDK import outside the provider module."
 *
 * ADR-0004 requires that geocoding access "sits behind a provider interface
 * so the choice stays reversible… No call site imports a vendor SDK directly.
 * Swapping providers must be a one-file change, not a search-and-replace
 * across the app" — and `geocoding.types.ts` names this file as the thing
 * that enforces that mechanically, rather than by code review remembering to
 * check it on every PR forever.
 *
 * This walks the real, on-disk `src` tree with `node:fs` rather than
 * hardcoding a file list (the same reasoning `service-catalogue.schema.test.ts`
 * uses for reading the seed file dynamically instead of duplicating its
 * contents): a new file added anywhere under `src` is covered by this test
 * automatically, with nothing here to update, and a legitimate new file added
 * *inside* `infra/geo/` never needs this test edited to tolerate it.
 */

const SRC_ROOT = path.join(__dirname, '../src');
const ALLOWED_DIR = path.join(SRC_ROOT, 'infra', 'geo');

/**
 * Vendor markers that must never appear outside the provider boundary. Not
 * `googleapis` alone: a vendor SDK can also be reached as a bare URL
 * (`fetch('https://maps.googleapis.com/...')`) or via a scoped package
 * (`@googlemaps/...`) without ever importing anything literally named
 * `googleapis`, and each of those would just as thoroughly defeat "swapping
 * providers is a one-file change" if it turned up in, say, a controller.
 */
const FORBIDDEN_STRINGS = ['googleapis', 'maps.googleapis.com', '@googlemaps'] as const;

/** Skips nothing but `node_modules` — the issue's own wording for this scan. */
const SKIPPED_DIR_NAMES = new Set(['node_modules']);

function isWithin(parentDir: string, filePath: string): boolean {
  const relative = path.relative(parentDir, filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIR_NAMES.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('no vendor maps SDK import outside src/infra/geo (issue #36)', () => {
  it('actually walks a non-trivial source tree, so an empty scan cannot pass this test for free', () => {
    // Positive control, same principle as `spyOnEveryLogSink`'s own note: a
    // walk that silently found zero files would pass the assertion below by
    // having nothing to complain about, which would prove nothing about the
    // codebase. `apps/api/src` carries well over a hundred files today; the
    // bound is set far below that so the control itself never flakes as the
    // tree grows, while still catching "the walk found nothing" outright.
    const files = walk(SRC_ROOT);
    expect(files.length).toBeGreaterThan(50);
  });

  it('finds every forbidden vendor string only in files under src/infra/geo', () => {
    const files = walk(SRC_ROOT);
    const violations: string[] = [];

    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf8');

      for (const marker of FORBIDDEN_STRINGS) {
        if (content.includes(marker) && !isWithin(ALLOWED_DIR, filePath)) {
          violations.push(`${filePath}: contains "${marker}"`);
        }
      }
    }

    // A bare boolean assertion here would tell whoever trips it nothing
    // useful — they would have to re-run the scan by hand to find out which
    // file, and which string, broke the boundary. `expect(actual, message)`'s
    // second argument is Vitest's custom-message form, so a failure prints
    // the offending file and string directly, and `toEqual([])` puts the
    // full list in the diff too, for when more than one file is at fault.
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
