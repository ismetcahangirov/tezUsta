import type { AppRole, AuthStatus } from '../store/session-slice';

/**
 * Which route group a screen is in, and where a user who does not belong there
 * should be sent instead.
 *
 * **This is UX, not security.** It hides what a role cannot use and keeps a
 * signed-out user off a screen that would only render errors. Anyone willing
 * to talk to the API directly bypasses all of it, which is why every
 * authorisation decision that matters is made by the server, per request,
 * against current database state (docs/architecture/authentication.md
 * § Authorization, layer 1; CLAUDE.md §11, §20). A reader must not come away
 * thinking this file protects anything.
 *
 * Expressed as a pure function rather than as `Stack.Protected` guards in the
 * root layout — which expo-router 57 does offer — for two reasons. The
 * decision here is not a boolean per screen but "which group does this user
 * belong in", and the answer has to be testable without mounting a navigator,
 * because the cases that matter are the role matrix and the dual-role switch.
 * `Stack.Protected` would also mean enumerating every screen in the root
 * layout, and the navigation pattern is the owner's decision, not this
 * issue's (CLAUDE.md §17).
 */

export const ROUTE_GROUPS = ['(auth)', '(customer)', '(master)', '(shared)'] as const;

export type RouteGroup = (typeof ROUTE_GROUPS)[number];

/** Where an unauthenticated user is sent. */
export const AUTH_ENTRY_ROUTE = '/(auth)/sign-in';

/**
 * The root of each role's experience.
 *
 * `as const satisfies` rather than a plain `Record<AppRole, string>`
 * annotation: expo-router's `Href` is a union of the app's real routes when
 * typed routes are generated, and a widened `string` would stop satisfying it
 * the day someone runs `expo start` and the generated types appear.
 */
export const ROLE_HOME_ROUTE = {
  customer: '/(customer)',
  master: '/(master)',
} as const satisfies Record<AppRole, string>;

/** The group a role's screens live in. */
const ROLE_GROUP = {
  customer: '(customer)',
  master: '(master)',
} as const satisfies Record<AppRole, RouteGroup>;

/** Every route this guard can send a user to. */
export type AuthRedirectTarget =
  typeof AUTH_ENTRY_ROUTE | (typeof ROLE_HOME_ROUTE)[keyof typeof ROLE_HOME_ROUTE];

export interface GuardedRoute {
  readonly status: AuthStatus;
  readonly grantedRoles: readonly AppRole[];
  /** The role the user has selected — a preference, not a grant. */
  readonly role: AppRole;
  /** The group being visited, or null at the root index route. */
  readonly group: RouteGroup | null;
}

/**
 * Reads a router segment as a known group. Anything else — a stray path, a
 * deep link into a group that does not exist — is `null` and treated as the
 * root, so an unknown route cannot become an unguarded one.
 */
export function toRouteGroup(segment: string | undefined): RouteGroup | null {
  return ROUTE_GROUPS.find((group) => group === segment) ?? null;
}

/**
 * The role whose experience the user actually gets.
 *
 * A selected role that is not granted is corrected here rather than by
 * redirecting to the granted role's home, because a redirect that leaves the
 * *selection* wrong bounces straight back: `(master)` sends the user to
 * `(customer)`, whose group then disagrees with the selection again. Deriving
 * the answer instead makes the guard a fixed point by construction.
 *
 * An empty `grantedRoles` means the token could not be read, not that the user
 * holds nothing (see `session-slice.ts`), so the selection stands.
 */
export function effectiveRole(grantedRoles: readonly AppRole[], role: AppRole): AppRole {
  if (grantedRoles.length === 0 || grantedRoles.includes(role)) {
    return role;
  }

  return grantedRoles[0] ?? role;
}

/**
 * The route this user should be on instead, or `null` to leave them where they
 * are.
 */
export function resolveAuthRedirect({
  status,
  grantedRoles,
  role,
  group,
}: GuardedRoute): AuthRedirectTarget | null {
  if (status === 'restoring') {
    // The stored refresh token has not been traded yet. Redirecting now would
    // send every returning user to the sign-in screen for the length of one
    // network round trip, and then yank them off it.
    return null;
  }

  if (status === 'signed-out') {
    return group === '(auth)' ? null : AUTH_ENTRY_ROUTE;
  }

  const home = ROLE_HOME_ROUTE[effectiveRole(grantedRoles, role)];

  if (group === '(shared)') {
    // Settings and profile belong to both roles.
    return null;
  }

  if (group === ROLE_GROUP[effectiveRole(grantedRoles, role)]) {
    return null;
  }

  // `(auth)` for a signed-in user, the other role's group, and the root index
  // all resolve to the same place: the home of the role they are actually in.
  return home;
}
