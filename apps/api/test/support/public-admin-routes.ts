/**
 * The `/admin` routes reached **before** an admin session exists
 * (`@PublicAdminRoute()`, ADR-0043 § 3–4), pinned here as a reviewed list.
 *
 * The route walks that prove "every admin route needs a session" and "every
 * admin route needs a permission" skip exactly these, and
 * `admin-credentials.e2e.test.ts` asserts that the routes carrying the marker
 * are exactly these — so adding a public admin route means editing this file,
 * in a diff somebody reads.
 */
export const PUBLIC_ADMIN_ROUTES: readonly string[] = [
  'POST /admin/auth/setup/start',
  'POST /admin/auth/setup/complete',
  'POST /admin/auth/sign-in',
  'POST /admin/auth/refresh',
  'POST /admin/auth/sign-out',
];

export function isPublicAdminRoute(route: { method: string; url: string }): boolean {
  return PUBLIC_ADMIN_ROUTES.includes(`${route.method} ${route.url}`);
}
