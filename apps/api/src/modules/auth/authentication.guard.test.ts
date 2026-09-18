import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { ActorService } from './actor.service';
import { AuthenticationGuard } from './authentication.guard';
import type { Actor } from './auth.types';
import { Public } from './public.decorator';
import type { TokenService } from './token.service';
import { InvalidAccessTokenError } from './token.service';

/**
 * `auth.guards.e2e.test.ts` proves what this guard *answers*, against a real
 * database and the real `AppModule` wiring. What it cannot observe is what the
 * guard **does not do**, and that is what is asserted here: a `@Public()` route
 * must not verify a token and must not touch the database, even when the caller
 * sends credentials.
 *
 * That is a behavioural claim with teeth. A guard that resolved the actor first
 * and checked the decorator afterwards would pass every HTTP assertion in the
 * suite while putting two queries on `/health/live` — a probe called once a
 * second by a load balancer — and would turn a database outage into a failing
 * liveness probe, which is precisely the feedback loop that restarts a healthy
 * process during an unrelated incident.
 */

class Routes {
  @Public()
  publicRoute(this: void): void {}

  protectedRoute(this: void): void {}
}

const ROUTES = new Routes();

const ACTOR: Actor = {
  userId: 'user-1',
  sessionId: 'session-1',
  roles: ['customer'],
  status: 'active',
};

interface Calls {
  readonly verified: string[];
  readonly resolved: number;
}

function buildGuard(): { guard: AuthenticationGuard; calls: Calls } {
  const verified: string[] = [];
  let resolved = 0;

  const tokens = {
    verifyAccessToken: (token: string) => {
      verified.push(token);
      return { sub: ACTOR.userId, sid: ACTOR.sessionId, roles: ACTOR.roles };
    },
  } as unknown as TokenService;

  const actors = {
    resolve: () => {
      resolved += 1;
      return Promise.resolve(ACTOR);
    },
  } as unknown as ActorService;

  return {
    guard: new AuthenticationGuard(new Reflector(), tokens, actors),
    calls: {
      verified,
      get resolved() {
        return resolved;
      },
    },
  };
}

function contextFor(
  handler: () => void,
  headers: Record<string, string> = {},
  url = '/customers/me',
): { context: ExecutionContext; request: FastifyRequest; headers: Record<string, unknown> } {
  // `url` is part of the fixture because the guard reads it: anything under
  // `/admin` belongs to `AdminAuthenticationGuard` and this one steps aside
  // (issue #39). A consumer path keeps every test below exercising the
  // consumer path.
  const request = { headers, url } as unknown as FastifyRequest;
  const replyHeaders: Record<string, unknown> = {};
  const reply = {
    header(name: string, value: unknown) {
      replyHeaders[name] = value;
      return reply;
    },
  } as unknown as FastifyReply;

  return {
    context: {
      getHandler: () => handler,
      getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
    } as unknown as ExecutionContext,
    request,
    headers: replyHeaders,
  };
}

describe('AuthenticationGuard', () => {
  it('lets a @Public() route through without verifying a token or reading the database', async () => {
    const { guard, calls } = buildGuard();
    const { context, request } = contextFor(ROUTES.publicRoute, {
      authorization: 'Bearer a-token-that-must-be-ignored',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(calls.verified).toEqual([]);
    expect(calls.resolved).toBe(0);
    // No actor either: a public handler must not be able to mistake a caller's
    // volunteered token for an authorization decision nobody made.
    expect(request.actor).toBeUndefined();
  });

  it('attaches the actor resolved from the database to a protected route', async () => {
    const { guard, calls } = buildGuard();
    const { context, request } = contextFor(ROUTES.protectedRoute, {
      authorization: 'Bearer a-valid-token',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(calls.verified).toEqual(['a-valid-token']);
    expect(calls.resolved).toBe(1);
    expect(request.actor).toEqual(ACTOR);
  });

  it('leaves the request id exactly as it found it, on the rejection path too', async () => {
    // This guard used to assign the id itself, because guards run before
    // interceptors and a rejection short-circuited the interceptor that would
    // otherwise have done it — so a 401 was answered with no way to correlate
    // it. That is now Fastify's `onRequest` hook's job (`RequestIdHook`, issue
    // #47), which runs before routing and therefore before this guard, and the
    // id must have exactly one source.
    //
    // What is asserted is the absence: the guard neither invents an id nor
    // overwrites the one already there. `test/request-id.e2e.test.ts` asserts
    // the positive half against the real pipeline, 401s included.
    const { guard } = buildGuard();
    const alreadyAssigned = 'assigned-by-the-onrequest-hook';
    const { context, request, headers } = contextFor(ROUTES.protectedRoute);
    request.requestId = alreadyAssigned;

    await expect(guard.canActivate(context)).rejects.toThrow(InvalidAccessTokenError);

    expect(request.requestId).toBe(alreadyAssigned);
    expect(headers['x-request-id']).toBeUndefined();
  });

  it.each([
    ['no header at all', undefined, 'missing_credentials'],
    ['a bare token with no scheme', 'a-valid-token', 'malformed_authorization_header'],
    ['the wrong scheme', 'Basic a-valid-token', 'malformed_authorization_header'],
    ['more than one space-separated part', 'Bearer a b', 'malformed_authorization_header'],
    ['an empty token', 'Bearer ', 'malformed_authorization_header'],
  ])(
    'refuses %s, carrying the reason on the error and never in its message',
    async (_name, header, expectedReason) => {
      const { guard, calls } = buildGuard();
      const { context } = contextFor(
        ROUTES.protectedRoute,
        header === undefined ? {} : { authorization: header },
      );

      const error = await guard.canActivate(context).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(InvalidAccessTokenError);
      const rejection = error as InvalidAccessTokenError;
      expect(rejection.reason).toBe(expectedReason);
      // The uniform 401 the client sees, identical for every reason above.
      expect(rejection.status).toBe(401);
      expect(rejection.message).toBe('Authentication required.');
      expect(rejection.details).toBeUndefined();
      // A malformed header never reaches signature verification or the database.
      expect(calls.verified).toEqual([]);
      expect(calls.resolved).toBe(0);
    },
  );
});
