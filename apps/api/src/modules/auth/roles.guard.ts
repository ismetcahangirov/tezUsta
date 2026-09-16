import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import type { UserRoleName } from '../../infra/database/schema/users';
import { REQUIRED_ROLES } from './roles.decorator';

/**
 * The 403 for "authenticated, but this is not yours to do."
 *
 * Carries no `details` and names no role. Telling the caller which role the
 * route wanted describes the platform's permission model to anyone with an
 * account, and a client that needs to know already knows — it chose the screen
 * the request came from.
 *
 * A 403 here is safe where a 403 on a resource id would not be: this answer is
 * about the *caller's own* capabilities, not about whether some other user's
 * row exists. That distinction is the whole reason ownership failures return
 * 404 instead (see `requireVisibleOrNotFound`).
 */
export class InsufficientRoleError extends AppError {
  constructor() {
    super(ERROR_CODES.FORBIDDEN, 'You do not have permission to perform this action.', 403);
    this.name = 'InsufficientRoleError';
    Object.setPrototypeOf(this, InsufficientRoleError.prototype);
  }
}

/**
 * Enforces `@Roles(...)`, reading the roles from `request.actor` — which
 * `AuthenticationGuard` filled in **from `user_roles`**, not from the token's
 * `roles` claim.
 *
 * That is the entire point of this guard existing separately from the decorator
 * that marks the route. Checking `claims.roles` would be one line shorter and
 * would authorise a master whose grant was withdrawn fourteen minutes ago,
 * because the claim is a cache of the database as it was at sign-in
 * (`docs/architecture/authentication.md` § Role claims are a cache, not an
 * authority). This guard never sees the claims at all, which is the structural
 * form of that rule: there is no token here to read the wrong thing from.
 *
 * Registered as a second `APP_GUARD` in `AppModule`, **after**
 * `AuthenticationGuard` — Nest runs global guards in registration order, and
 * this one depends on the actor the first one attaches.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<readonly UserRoleName[] | undefined>(
      REQUIRED_ROLES,
      [context.getHandler(), context.getClass()],
    );

    // No `@Roles(...)` means the route is open to any authenticated caller.
    // It does **not** mean the route is open: `AuthenticationGuard` has already
    // run and already rejected anyone without a valid actor.
    if (required === undefined || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const actor = request.actor;
    if (actor === undefined) {
      // Only reachable if a route carries both `@Public()` and `@Roles(...)` —
      // a contradiction, and one that would otherwise resolve silently in
      // favour of `@Public()`, shipping an unauthenticated route that reads as
      // role-restricted. Refusing is the safe half of that contradiction.
      throw new InsufficientRoleError();
    }

    if (!required.some((role) => actor.roles.includes(role))) {
      throw new InsufficientRoleError();
    }

    return true;
  }
}
