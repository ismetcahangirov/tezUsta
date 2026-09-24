import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminPermission } from '@tezusta/types';
import type { FastifyRequest } from 'fastify';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { requestLogContext } from '../../common/request-context/request-context';
import { ADMIN_PERMISSION_KEY } from './admin-permission.decorator';
import type { AdminPermissionRequirement } from './admin-permission.decorator';
import type { AdminActor } from './admin.types';
import { isAdminRequest } from './admin.types';

/**
 * The admin 403. Like `InsufficientRoleError`, it names no permission: which
 * one a route wanted is a description of the permission model, and the panel
 * already knows what it asked for.
 */
export class InsufficientAdminPermissionError extends AppError {
  constructor() {
    super(ERROR_CODES.FORBIDDEN, 'You do not have permission to perform this action.', 403);
    this.name = 'InsufficientAdminPermissionError';
    Object.setPrototypeOf(this, InsufficientAdminPermissionError.prototype);
  }
}

/** Throws unless the admin holds `permission` — for requirements a handler refines. */
export function assertAdminPermission(admin: AdminActor, permission: AdminPermission): void {
  if (!admin.permissions.includes(permission)) {
    throw new InsufficientAdminPermissionError();
  }
}

/**
 * Authorization for the admin surface (ADR-0043 § 1), **deny by default**.
 *
 * Registered as an `APP_GUARD` directly after `AdminAuthenticationGuard`,
 * whose resolved actor — roles read from `admin_user_roles` on this request,
 * never from the token — it depends on.
 *
 * A handler under `/admin` with no `@RequireAdminPermission()` or
 * `@AnyAdmin()` is refused. That is the same "guarded by construction"
 * argument that makes the authentication guard key on the path: a forgotten
 * decorator must fail closed, and `admin-permissions.e2e.test.ts` walks every
 * registered admin handler to prove none is undeclared.
 */
@Injectable()
export class AdminPermissionGuard implements CanActivate {
  private readonly logger = new Logger(AdminPermissionGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!isAdminRequest(request)) {
      return true;
    }

    const requirement = this.reflector.getAllAndOverride<AdminPermissionRequirement | undefined>(
      ADMIN_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (requirement === undefined) {
      // A programming error, not a caller's: logged at `error` so it is seen,
      // and answered with the same 403 so it is not an oracle.
      this.logger.error(
        `${requestLogContext(request)} admin handler declares no permission — refused by default`,
      );
      throw new InsufficientAdminPermissionError();
    }

    const admin = request.adminActor;
    if (admin === undefined) {
      // Unreachable while AdminAuthenticationGuard runs first; failing closed
      // keeps this guard's answer independent of that ordering.
      throw new InsufficientAdminPermissionError();
    }

    if (requirement.anyOf.length === 0) {
      return true;
    }
    if (requirement.anyOf.some((permission) => admin.permissions.includes(permission))) {
      return true;
    }
    throw new InsufficientAdminPermissionError();
  }
}
