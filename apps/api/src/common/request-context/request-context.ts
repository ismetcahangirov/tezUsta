import { randomUUID } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import type { Actor } from '../../modules/auth/auth.types';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by {@link ensureRequestId} before anything else reads it. */
    requestId: string;
    /**
     * The caller, re-read from the database by `AuthenticationGuard` on every
     * authenticated request — never assembled from token claims (issue #27).
     *
     * Optional because three states are legitimate and distinct: a public route
     * has no actor, a rejected request never gets one, and a protected route
     * always has one by the time its handler runs. `@CurrentActor()` is what
     * turns that optional into a non-optional at a call site.
     */
    actor?: Actor;
  }
}

/**
 * An inbound `x-request-id` is untrusted input: logged verbatim, it is a
 * log-injection vector, so it is accepted only when it matches this safe
 * pattern. Anything else — including no header at all — gets a fresh id.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * What {@link ensureRequestId} needs from a request, named structurally rather
 * than as `FastifyRequest`.
 *
 * `@nestjs/platform-fastify` types its adapter hooks against its own resolution
 * of fastify's `FastifyRequest`, and the `declare module 'fastify'` augmentation
 * above does not reach it: the hook's parameter has no `requestId` property at
 * all, so passing it where a `FastifyRequest` is expected fails to compile under
 * `exactOptionalPropertyTypes`. Describing the shape rather than naming the
 * class lets `RequestIdHook`, the guards and the exception filter share one
 * implementation without a cast (CLAUDE.md §20 — `any` is not an option).
 */
export interface RequestIdCarrier {
  readonly headers: Record<string, string | string[] | undefined>;
  requestId?: string;
}

/** The one thing {@link ensureRequestId} does to a reply. */
export interface RequestIdReplyTarget {
  header(key: string, value: string): unknown;
}

/**
 * Resolves the request id **idempotently**, and is why this function exists at
 * all rather than the logic living only inside `RequestIdInterceptor`.
 *
 * Nest's request lifecycle runs guards *before* interceptors, so by the time
 * `RequestIdInterceptor` executes the authentication guard has already had its
 * chance to reject the request — and a guard that throws short-circuits the
 * pipeline, so the interceptor never runs at all. Leaving the id to the
 * interceptor alone would therefore mean every 401 in the system logged
 * `[unknown]` and answered without an `x-request-id` header: the one class of
 * failure a support conversation most needs to correlate would be the one class
 * that cannot be. The guard calls this first, the interceptor calls it second
 * and finds the id already there, and both paths agree on one value.
 */
export function ensureRequestId(request: RequestIdCarrier, reply: RequestIdReplyTarget): string {
  // The one place that has to reason about the window before the id is
  // assigned: the `fastify` augmentation above declares `requestId` as a plain
  // `string`, which is what it is for every consumer downstream of here.
  const existing: string | undefined = request.requestId;
  if (existing !== undefined) {
    return existing;
  }

  const inbound = request.headers['x-request-id'];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const requestId =
    candidate !== undefined && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();

  request.requestId = requestId;
  reply.header('x-request-id', requestId);
  return requestId;
}

/**
 * The prefix every server-side log line about a request carries:
 * `[<requestId>]`, or `[<requestId> actor=<userId>]` once a guard has resolved
 * one.
 *
 * The actor id — and only the id — is what ties a failure to a user (issue
 * #27). Nothing else about the actor belongs in a log line: the phone number is
 * PII and the roles are reconstructable from the id, so adding either would
 * spread identifying data across every log sink for no diagnostic gain
 * (CLAUDE.md §11).
 */
export function requestLogContext(request: FastifyRequest): string {
  const requestId: string | undefined = request.requestId;
  const actorId = request.actor?.userId;

  return actorId === undefined
    ? `[${requestId ?? 'unknown'}]`
    : `[${requestId ?? 'unknown'} actor=${actorId}]`;
}
