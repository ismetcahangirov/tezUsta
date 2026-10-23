import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MOBILE_ROOT = path.resolve(__dirname, '../..');

/**
 * The web subscription page's API surface (ADR-0061 § 3), **read from the
 * page's own source, not transcribed**: `apps/mobile` may not import
 * `apps/web`, and a hand-copied list would stop guarding the day the page
 * gains a route.
 */
const WEB_API_FILE = path.resolve(MOBILE_ROOT, '../web/src/api/web-api.ts');

/**
 * What the app may share with the page: the master's own status, which the
 * app shows for its own reasons (#325). Everything else the page calls is the
 * page's alone.
 */
const SHARED_WITH_THE_APP = new Set(['/masters/me/subscription']);

/**
 * The page's public origin, once the owner names its domain (ADR-0061
 * § 1). Add it here then: it is the one thing this guard cannot read from the
 * repository today.
 */
const PAGE_ORIGINS: readonly string[] = [];

function pageOnlyRoutes(): string[] {
  const source = readFileSync(WEB_API_FILE, 'utf8');
  const routes = [...source.matchAll(/'(\/[a-z/-]+)'/g)]
    .map((match) => match[1] ?? '')
    .filter((route) => !SHARED_WITH_THE_APP.has(route));

  if (routes.length < 5) {
    throw new Error(
      `Read only ${String(routes.length)} routes from ${WEB_API_FILE}. The guard below would ` +
        'pass without checking much, so the pattern has drifted from the file and must be fixed.',
    );
  }
  return routes;
}

const SOURCE = /\.(ts|tsx|js)$/;
/** Test fixtures may name a route; only shipped code is guarded. */
const EXCLUDED = /\.(test|stories)\.(ts|tsx)$/;

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
 * **ADR-0046 § 7, asserted rather than assumed**: the subscription is sold on
 * the web, and the app contains no link to the page, no price and no call to
 * action — Apple 3.1.1 and Google Play's payments policy. A quoted route is
 * how such a thing would arrive: a "renew" button calling the checkout, or a
 * price read from the offer.
 */
describe('the app and the web subscription page', () => {
  it('calls none of the page’s routes and names none of its origins', () => {
    const forbidden = [...pageOnlyRoutes().map((route) => `'${route}'`), ...PAGE_ORIGINS];
    const offenders: string[] = [];

    for (const file of [
      ...sourceFiles(path.join(MOBILE_ROOT, 'src')),
      ...sourceFiles(path.join(MOBILE_ROOT, 'app')),
      path.join(MOBILE_ROOT, 'app.config.js'),
    ]) {
      const contents = readFileSync(file, 'utf8');
      for (const needle of forbidden) {
        if (contents.includes(needle)) {
          offenders.push(`${path.relative(MOBILE_ROOT, file)} contains ${needle}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
