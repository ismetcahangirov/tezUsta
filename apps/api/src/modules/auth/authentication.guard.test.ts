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
      // A global guard is asked about every context type, and since issue #166
      // the process has a WebSocket gateway as well. The guard refuses
      // anything that is not `http`, so every fixture above has to say which
      // it is — the `ws` case is exercised on its own below.
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
    } as unknown as ExecutionContext,
    request,
    headers: replyHeaders,
  };
}

/**
 * A context that is not HTTP. `switchToHttp().getRequest()` deliberately
 * returns a socket-shaped object with no `headers`: that is what Nest actually
 * hands back for a WebSocket execution, and it is why reading it would be
 * wrong rather than merely useless.
 *
 * `data` is what `SocketAuthenticator` fills at the upgrade. Passing
 * `undefined` models a socket that never authenticated — which is what the
 * guard must refuse — and passing an actor models one that did (issue #167).
 */
function websocketContextFor(
  handler: () => void,
  data: { actor?: unknown } | undefined = undefined,
): ExecutionContext {
  const client = data === undefined ? { id: 'a-socket-id' } : { id: 'a-socket-id', data };

  return {
    getHandler: () => handler,
    getClass: () => Routes,
    getType: () => 'ws',
    switchToHttp: () => ({ getRequest: () => client, getResponse: () => ({}) }),
    switchToWs: () => ({ getClient: () => client, getData: () => ({}) }),
  } as unknown as ExecutionContext;
}

/** A context type nobody has reasoned about — neither `http` nor `ws`. */
function unknownContextFor(handler: () => void): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Routes,
    getType: () => 'rpc',
    switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => ({}) }),
    switchToWs: () => ({ getClient: () => ({}), getData: () => ({}) }),
  } as unknown as ExecutionContext;
}

describe('AuthenticationGuard', () => {
  describe('a non-HTTP execution context (issues #166, #167)', () => {
    it('refuses a socket that never authenticated, rather than reading it as a request', async () => {
      const { guard, calls } = buildGuard();

      await expect(guard.canActivate(websocketContextFor(ROUTES.protectedRoute))).rejects.toThrow(
        InvalidAccessTokenError,
      );

      // Nothing was verified and nothing was read: the socket's credential was
      // spent at the upgrade and destroyed there, so there is nothing here for
      // the guard to check even if it wanted to.
      expect(calls.verified).toEqual([]);
      expect(calls.resolved).toBe(0);
    });

    it('refuses an unauthenticated socket even for a route marked @Public()', async () => {
      // `@Public()` is a statement about an HTTP route. Honouring it here
      // would mean the first `@SubscribeMessage` handler someone adds under a
      // `@Public()` class is silently unguarded, which is the failure this
      // branch exists to make loud.
      const { guard } = buildGuard();

      await expect(guard.canActivate(websocketContextFor(ROUTES.publicRoute))).rejects.toThrow(
        InvalidAccessTokenError,
      );
    });

    it('admits a socket that already carries the actor the middleware resolved', async () => {
      // #167 gave the gateway message handlers. A socket reaching one has
      // already been authenticated by `SocketAuthenticator`, before the
      // connection was established — so the guard accepts the proof rather
      // than demanding a second one it could not obtain.
      const { guard, calls } = buildGuard();

      await expect(
        guard.canActivate(
          websocketContextFor(ROUTES.protectedRoute, { actor: { userId: 'u-1', roles: [] } }),
        ),
      ).resolves.toBe(true);

      // Still nothing verified or resolved: this branch reads what the upgrade
      // already decided, and never re-authenticates per message.
      expect(calls.verified).toEqual([]);
      expect(calls.resolved).toBe(0);
    });

    it('refuses an execution context that is neither HTTP nor a socket', async () => {
      // A microservice or RPC context would be a surface nobody reasoned
      // about, and inheriting the socket branch would mean whatever object it
      // hands back deciding the answer.
      const { guard } = buildGuard();

      await expect(guard.canActivate(unknownContextFor(ROUTES.protectedRoute))).rejects.toThrow(
        InvalidAccessTokenError,
      );
    });
  });

  it('never verifies a consumer token on a route the router matched under /admin, whatever the URL says (#269)', async () => {
    // The router matched an admin handler for a URL whose raw spelling does
    // not start with `/admin`. The consumer guard must refuse rather than
    // authenticate the consumer token it was handed.
    const { guard, calls } = buildGuard();
    const { context, request } = contextFor(
      ROUTES.protectedRoute,
      { authorization: 'Bearer a-valid-consumer-token' },
      '/%61dmin/orders',
    );
    Object.assign(request, { routeOptions: { url: '/admin/orders' } });

    await expect(guard.canActivate(context)).rejects.toThrow(InvalidAccessTokenError);

    expect(calls.verified).toEqual([]);
    expect(calls.resolved).toBe(0);
    expect(request.actor).toBeUndefined();
  });

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
