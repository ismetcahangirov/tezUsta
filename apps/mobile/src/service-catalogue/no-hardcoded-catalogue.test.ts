import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MOBILE_ROOT = path.resolve(__dirname, '../..');

/**
 * The seed file whose names the app must not contain
 * (`apps/api/src/infra/database/seed/service-catalogue.seed-data.ts`).
 *
 * **Read, not imported.** `apps/mobile` may not import `apps/api` — it is a
 * CI-failing dependency-cruiser rule — so this reads the file's text. Reading
 * rather than transcribing is what keeps the guard honest: a hand-copied list
 * of names goes stale the first time the seed is edited, and a guard test that
 * silently stops checking anything is the worst kind to have.
 */
const SEED_FILE = path.resolve(
  MOBILE_ROOT,
  '../api/src/infra/database/seed/service-catalogue.seed-data.ts',
);

/**
 * The catalogue strings the app must not contain, pulled out of the seed's
 * source rather than listed here — listing them would be the very thing this
 * test forbids.
 *
 * **Two deliberate filters, because a guard that cries wolf gets deleted.**
 * Only the Azerbaijani names are taken, not the English ones: "Other",
 * "Locks", "Painting" and "Cleaning" are ordinary English words that appear in
 * prose and comments, and a guard that fails on the word "other" teaches
 * everyone to ignore it. Only hyphenated slugs are taken, for the same reason
 * — `plumbing` could plausibly appear in a sentence, `air-conditioning` could
 * not. Every dropped string has a kept counterpart in the same row, so no
 * catalogue entry goes unguarded.
 */
function catalogueNames(): string[] {
  const seed = readFileSync(SEED_FILE, 'utf8');

  const azerbaijaniNames = [...seed.matchAll(/az: '([^']+)'/g)]
    .map((match) => match[1] ?? '')
    .filter((name) => name.length >= 5);

  const compoundSlugs = [...seed.matchAll(/slug: '([^']+)'/g)]
    .map((match) => match[1] ?? '')
    .filter((slug) => slug.includes('-'));

  const all = [...azerbaijaniNames, ...compoundSlugs];

  if (all.length < 40) {
    throw new Error(
      `Read only ${String(all.length)} names from the seed file. The guard below would pass ` +
        'without checking much, so the patterns have drifted from the seed and must be fixed.',
    );
  }

  return all;
}

/** Storybook sample data and test fixtures are allowed to name a category. */
const EXCLUDED = /\.(test|stories)\.(ts|tsx)$/;
const SOURCE = /\.(ts|tsx)$/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(full);
    }
    return SOURCE.test(entry.name) && !EXCLUDED.test(entry.name) ? [full] : [];
  });
}

/**
 * **The acceptance criterion EPIC 3 is actually about**, asserted rather than
 * assumed: adding a service must never require an app release, which is only
 * true while the app names no service.
 *
 * A reviewer can read `CategoryList` and see that it renders its props. What a
 * reviewer cannot do is notice, two Epics from now, that somebody added a
 * "popular services" shortcut with three slugs in it — which is exactly how an
 * app quietly acquires a second, stale copy of the catalogue that nobody
 * remembers to update.
 */
describe('the app itself', () => {
  it('names no category and no service anywhere in its shipped source', () => {
    const names = catalogueNames();
    const offenders: string[] = [];

    for (const file of [
      ...sourceFiles(path.join(MOBILE_ROOT, 'src')),
      ...sourceFiles(path.join(MOBILE_ROOT, 'app')),
    ]) {
      const contents = readFileSync(file, 'utf8');
      for (const name of names) {
        if (contents.includes(name)) {
          offenders.push(`${path.relative(MOBILE_ROOT, file)} contains "${name}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
