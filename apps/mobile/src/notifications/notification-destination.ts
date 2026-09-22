import type { NotificationKind } from '@tezusta/types';

import { effectiveRole, ROLE_HOME_ROUTE } from '../auth/route-guard';
import type { AppRole } from '../store/session-slice';

/**
 * Whose experience a notification belongs to, as far as its **kind** can say.
 *
 * `'either'` is not a gap in the table, it is a fact about the server's
 * recipient rule. A status transition notifies everybody on the order except
 * whoever caused it (`apps/api/.../order-notification-plan.ts`), so the same
 * kind reaches a customer when the master acted and a master when the customer
 * did. `order-cancelled` is the clearest case: a customer cancelling notifies
 * the master, an admin cancelling notifies both. Naming a role there would be
 * guessing, and the guess would be wrong half the time.
 */
export type NotificationAudience = AppRole | 'either';

/** What a notification turned out to be about, once its payload was read. */
export interface NotificationTarget {
  readonly kind: NotificationKind;
  /** Every kind this Epic raises is about an order. */
  readonly orderId: string;
  readonly audience: NotificationAudience;
}

/**
 * The closed table the whole feature turns on.
 *
 * **A payload never names a screen; it names a kind, and this maps it.** That
 * is the difference between the app deciding what to render and a stranger on
 * the network deciding — a notification arrives over the internet, and
 * CLAUDE.md §11's "validate every input" does not stop at the API boundary.
 *
 * `satisfies Record<NotificationKind, …>` is what keeps it closed from the
 * other side: a kind added to `@tezusta/types` and not given an audience here
 * is a compile error, not a notification that silently opens nothing.
 */
const AUDIENCE_OF_KIND = {
  /** Only masters are broadcast to. */
  'order-offer': 'master',
  /** The master is the actor, so the customer is who hears about it. */
  'order-accepted': 'customer',
  /** Usually the master acting and the customer hearing — but an admin override (#137) reaches both. */
  'order-status-changed': 'either',
  /** A customer cancelling notifies the master; an admin cancelling notifies both. */
  'order-cancelled': 'either',
  /** The master stepped back and the search resumed; the customer is who needs to know. */
  'order-redispatched': 'customer',
  /** The search ended with nobody, and only the customer was waiting. */
  'order-no-master-found': 'customer',
} as const satisfies Record<NotificationKind, NotificationAudience>;

/** Where a notification can send the app. */
export interface NotificationRoute {
  /** The role whose experience to switch to before navigating. */
  readonly role: AppRole;
  readonly route: (typeof ROLE_HOME_ROUTE)[AppRole];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function knownKind(value: unknown): value is NotificationKind {
  return typeof value === 'string' && value in AUDIENCE_OF_KIND;
}

/**
 * Reads a notification payload, or refuses it.
 *
 * **Everything not in the table is dropped on the floor**, including a `url`,
 * a `path` or a `screen` somebody put in the payload — they are never copied
 * into the result, so nothing downstream is even able to navigate to them.
 * Refusing is not a failure state: an app that opens and stays where it was is
 * the sensible landing for a kind it has never heard of, and it is the only
 * answer that cannot be steered from outside.
 *
 * `null` means "do not navigate", and every caller treats it that way.
 */
export function readNotificationTarget(data: unknown): NotificationTarget | null {
  if (!isRecord(data)) {
    return null;
  }

  const { kind, orderId } = data;

  if (!knownKind(kind)) {
    return null;
  }

  if (typeof orderId !== 'string' || orderId.trim() === '') {
    return null;
  }

  return { kind, orderId, audience: AUDIENCE_OF_KIND[kind] };
}

/** What the session says about who is holding the phone. */
export interface RoutingSession {
  readonly grantedRoles: readonly AppRole[];
  /** The role currently on screen — a preference, not a grant. */
  readonly role: AppRole;
}

/**
 * Where a target sends this particular user, or `null` to leave them alone.
 *
 * **The route is the role home, and that is a placeholder with a date on it.**
 * Nothing in `apps/mobile` renders an order yet — there is no order detail
 * screen and no master offer feed — so there is no screen for `orderId` to
 * open. What works today is the half that does not need one: the app lands in
 * the role the notification is about, which is a real correction for a master
 * reading the app as a customer. When an order screen exists, this function is
 * where it is named, and `NotificationTarget` already carries the id it will
 * need.
 *
 * **A role the account does not hold is refused rather than corrected.** A
 * customer-only account receiving a master's notification means a stale device
 * registration or a server bug, and opening a role experience there would show
 * a screen made entirely of errors. Empty grants are the exception: they mean
 * the access token could not be read, not that the user holds nothing — the
 * same reading `route-guard.ts` uses — so the notification is trusted and the
 * route guard corrects it afterwards if it was wrong.
 */
export function resolveNotificationRoute(
  target: NotificationTarget,
  session: RoutingSession,
): NotificationRoute | null {
  const current = effectiveRole(session.grantedRoles, session.role);

  if (target.audience === 'either') {
    return { role: current, route: ROLE_HOME_ROUTE[current] };
  }

  const wanted = target.audience;

  if (session.grantedRoles.length > 0 && !session.grantedRoles.includes(wanted)) {
    return null;
  }

  return { role: wanted, route: ROLE_HOME_ROUTE[wanted] };
}
