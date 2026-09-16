import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { Actor } from './auth.types';

/**
 * Injects the actor `AuthenticationGuard` resolved for this request:
 * `handler(@CurrentActor() actor: Actor)`.
 *
 * Exists so a handler never reaches into `request.actor` — and therefore never
 * has to reason about the `undefined` that property legitimately holds on a
 * public route. Here that case is an exception rather than a value, so the
 * handler's parameter is a plain `Actor` and a forgotten null check cannot
 * become a handler that treats "nobody" as "somebody".
 *
 * The throw is a 500, deliberately, and is not a client error: reaching it
 * means a route was written with both `@Public()` and `@CurrentActor()`, which
 * is a mistake in our source that no request can cause and no request should be
 * told about. It surfaces as the generic 500 the filter produces, with the real
 * message in the server log beside the request id.
 */
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const actor = request.actor;

    if (actor === undefined) {
      throw new Error(
        '@CurrentActor() was used on a route the authentication guard did not resolve an actor ' +
          'for. A route cannot be both @Public() and actor-aware — remove one of them.',
      );
    }

    return actor;
  },
);
