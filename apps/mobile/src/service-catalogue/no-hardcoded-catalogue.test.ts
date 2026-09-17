import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Names from the launch catalogue's seed data
 * (`apps/api/src/infra/database/seed/service-catalogue.seed-data.ts`).
 *
 * Not every name — enough of them that any attempt to reintroduce a hardcoded
 * list trips at least one. The point is not to enumerate the catalogue here
 * either; that would be the very thing being forbidden.
 */
const CATALOGUE_NAMES = [
  'Santexnika',
  'Kondisioner',
  'Məişət texnikasının təmiri',
  'Mebel yığılması',
  'plumbing',
  'air-conditioning',
  'furniture-assembly',
];

const MOBILE_ROOT = path.resolve(__dirname, '../..');

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
    const offenders: string[] = [];

    for (const file of [
      ...sourceFiles(path.join(MOBILE_ROOT, 'src')),
      ...sourceFiles(path.join(MOBILE_ROOT, 'app')),
    ]) {
      const contents = readFileSync(file, 'utf8');
      for (const name of CATALOGUE_NAMES) {
        if (contents.includes(name)) {
          offenders.push(`${path.relative(MOBILE_ROOT, file)} contains "${name}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
