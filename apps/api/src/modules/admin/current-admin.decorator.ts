import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { AdminActor } from './admin.types';

/**
 * The authenticated admin, for an admin route handler.
 *
 * Throws rather than returning `undefined` if no admin was resolved, because
 * that combination means the route escaped `AdminAuthenticationGuard` — a
 * programming error worth a 500 and a stack trace, not a handler quietly
 * running for nobody.
 */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminActor => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const adminActor = request.adminActor;
    if (adminActor === undefined) {
      throw new Error(
        '@CurrentAdmin() was used on a route the admin authentication guard did not resolve an ' +
          'admin for. Admin routes are identified by the /admin path prefix — see isAdminRequest().',
      );
    }
    return adminActor;
  },
);
