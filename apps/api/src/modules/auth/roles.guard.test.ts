import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { Actor } from './auth.types';
import { Public } from './public.decorator';
import { Roles } from './roles.decorator';
import { InsufficientRoleError, RolesGuard } from './roles.guard';

/**
 * `auth.guards.e2e.test.ts` covers this guard through real HTTP, which is where
 * the answers that matter are asserted. What is here instead are the two states
 * an HTTP test cannot reach without shipping a route that should not exist: a
 * route carrying no `@Roles(...)` at all, and the contradiction of `@Public()`
 * together with `@Roles(...)`.
 *
 * The second is the one worth the file. It is a mistake in our own source, not
 * something a request can cause, and it resolves silently — `@Public()` wins in
 * `AuthenticationGuard`, so the route ships unauthenticated while reading as
 * role-restricted. Refusing is the only safe reading of a contradiction, and
 * this is the only place that can be proven.
 */
class Routes {
  @Roles('master')
  masterOnly(this: void): void {}

  openToAnyAuthenticatedCaller(this: void): void {}

  @Public()
  @Roles('master')
  contradictory(this: void): void {}
}

const ROUTES = new Routes();

const MASTER: Actor = {
  userId: 'user-1',
  sessionId: 'session-1',
  roles: ['master'],
  status: 'active',
};
const CUSTOMER: Actor = { ...MASTER, roles: ['customer'] };
const BOTH: Actor = { ...MASTER, roles: ['customer', 'master'] };
const ROLELESS: Actor = { ...MASTER, roles: [] };

function contextFor(handler: () => void, actor?: Actor): ExecutionContext {
  const request = { ...(actor === undefined ? {} : { actor }) } as unknown as FastifyRequest;

  return {
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('lets an undecorated route through for any authenticated caller', () => {
    expect(guard.canActivate(contextFor(ROUTES.openToAnyAuthenticatedCaller, CUSTOMER))).toBe(true);
  });

  it('lets a caller holding the required role through', () => {
    expect(guard.canActivate(contextFor(ROUTES.masterOnly, MASTER))).toBe(true);
  });

  it('lets a caller holding the required role among several through', () => {
    expect(guard.canActivate(contextFor(ROUTES.masterOnly, BOTH))).toBe(true);
  });

  it('refuses a caller holding a different role', () => {
    expect(() => guard.canActivate(contextFor(ROUTES.masterOnly, CUSTOMER))).toThrow(
      InsufficientRoleError,
    );
  });

  it('refuses a caller holding no role at all — an account exists before a role is chosen', () => {
    expect(() => guard.canActivate(contextFor(ROUTES.masterOnly, ROLELESS))).toThrow(
      InsufficientRoleError,
    );
  });

  it('refuses a route that is both @Public() and @Roles(...), rather than silently serving it', () => {
    expect(() => guard.canActivate(contextFor(ROUTES.contradictory, undefined))).toThrow(
      InsufficientRoleError,
    );
  });

  it('answers 403 with a message that names no role', () => {
    const error = new InsufficientRoleError();

    expect(error.status).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).not.toContain('master');
    expect(error.message).not.toContain('customer');
    expect(error.details).toBeUndefined();
  });
});
