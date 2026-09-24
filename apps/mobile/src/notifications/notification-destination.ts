import type { NotificationKind } from '@tezusta/types';

import { effectiveRole, ROLE_HOME_ROUTE } from '../auth/route-guard';
import type { AppRole } from '../store/session-slice';
import { CALL_RING_KIND, readCallId } from './call-notification';

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
  /**
   * The call a ring push names — `call-incoming` only, and only once shaped
   * like an id. **Untrusted even then**: it is what the app asks the server
   * about (`GET /calls/:callId`), never what it acts on.
   */
  readonly callId?: string;
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
  /**
   * Either party can write, so either can be told (#180). The role on screen
   * decides, as it does for a status change.
   */
  'message-received': 'either',
  /**
   * Either party can ring the other (#189), so the role on screen decides.
   * The route here is the **fallback**: `useNotificationRouting` first
   * confirms the call with `GET /calls/:callId` and opens the incoming screen
   * if it is still ringing this account. A tap after the ring stopped — or
   * any ring while calling ships dark — lands on the job the call was about.
   */
  'call-incoming': 'either',
} as const satisfies Record<NotificationKind, NotificationAudience>;

/**
 * The route to the customer's order screen
 * ([ADR-0029](../../../../docs/decisions/ADR-0029-customer-order-screen.md)).
 *
 * The **object** form rather than an interpolated path, because expo-router's
 * generated types describe a dynamic route as a pathname plus params; an id
 * spliced into a template would be a string this file asserted was a route
 * rather than one the router agreed was.
 */
export const CUSTOMER_ORDER_ROUTE = '/(customer)/order/[id]' as const;

/**
 * The customer's conversation on one order, pushed over the order screen
 * ([ADR-0033](../../../../docs/decisions/ADR-0033-in-order-messaging.md) § 6).
 */
export const CUSTOMER_CONVERSATION_ROUTE = '/(customer)/order/[id]/chat' as const;

/** The master's conversation on one order, in their single stack (ADR-0036, #182). */
export const MASTER_CONVERSATION_ROUTE = '/(master)/chat/[orderId]' as const;

/** Where a notification can send the app. */
export type NotificationHref =
  | (typeof ROLE_HOME_ROUTE)[AppRole]
  | {
      readonly pathname: typeof CUSTOMER_ORDER_ROUTE | typeof CUSTOMER_CONVERSATION_ROUTE;
      readonly params: { readonly id: string };
    }
  | {
      readonly pathname: typeof MASTER_CONVERSATION_ROUTE;
      readonly params: { readonly orderId: string };
    };

export interface NotificationRoute {
  /** The role whose experience to switch to before navigating. */
  readonly role: AppRole;
  readonly route: NotificationHref;
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

  if (kind === CALL_RING_KIND) {
    // The server always sends the call id with a ring. One that is missing or
    // not shaped like an id is a payload this app did not get from its
    // server, and is ignored rather than half-trusted.
    const callId = readCallId(data.callId);
    return callId === null ? null : { kind, orderId, audience: AUDIENCE_OF_KIND[kind], callId };
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
 * **A customer lands on the order; a master lands on their home** (#155
 * closing the half of #146 that had nowhere to go). Every kind this Epic
 * raises is about an order, and the customer now has a screen for one — so the
 * id the target has always carried is finally used. There is no master-facing
 * order screen yet and no offer feed, so a master keeps the role home: naming a
 * route that does not exist is exactly the guess this table exists to prevent.
 *
 * The role is still decided first, and the route follows from it. That ordering
 * matters for `'either'`, where the same kind reaches a customer when the master
 * acted and a master when the customer did.
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
    return { role: current, route: routeFor(current, target) };
  }

  const wanted = target.audience;

  if (session.grantedRoles.length > 0 && !session.grantedRoles.includes(wanted)) {
    return null;
  }

  return { role: wanted, route: routeFor(wanted, target) };
}

/**
 * The screen one role opens for one target.
 *
 * **A message opens the conversation it was written in**, for either role
 * (#180) — that is the one thing the person tapping it wants to read. Every
 * other kind opens the customer's order, or the master's home: the master's
 * home already shows the job they are on (ADR-0036), and naming a
 * master-facing order screen that does not exist is exactly the guess this
 * table exists to prevent.
 */
function routeFor(role: AppRole, target: NotificationTarget): NotificationHref {
  if (target.kind === 'message-received') {
    return role === 'customer'
      ? { pathname: CUSTOMER_CONVERSATION_ROUTE, params: { id: target.orderId } }
      : { pathname: MASTER_CONVERSATION_ROUTE, params: { orderId: target.orderId } };
  }

  return role === 'customer'
    ? { pathname: CUSTOMER_ORDER_ROUTE, params: { id: target.orderId } }
    : ROLE_HOME_ROUTE[role];
}
