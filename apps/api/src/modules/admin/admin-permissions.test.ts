import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminPermission } from '@tezusta/types';
import { describe, expect, it } from 'vitest';

import { AnyAdmin, RequireAdminPermission } from './admin-permission.decorator';
import { AdminPermissionGuard, InsufficientAdminPermissionError } from './admin-permission.guard';
import { ADMIN_PERMISSIONS, permissionsFor, ROLE_PERMISSIONS } from './admin-permissions';
import { permissionForAdminTransition } from './admin-orders.service';
import type { AdminActor } from './admin.types';

describe('the role bundles (ADR-0043 § 1)', () => {
  it('gives super_admin every permission', () => {
    expect(permissionsFor(['super_admin'])).toEqual(ADMIN_PERMISSIONS);
  });

  it('keeps master review and suspension away from support', () => {
    const support = permissionsFor(['support']);
    expect(support).not.toContain('masters.review');
    expect(support).not.toContain('masters.suspend');
    expect(support).toContain('orders.override');
  });

  it('keeps live-order overrides away from moderator and finance', () => {
    expect(permissionsFor(['moderator'])).not.toContain('orders.override');
    expect(permissionsFor(['finance'])).not.toContain('orders.override');
  });

  it('gives the refund outcome only to finance and super_admin', () => {
    const holders = (Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]).filter(
      (role) => ROLE_PERMISSIONS[role].includes('disputes.refund'),
    );
    expect(holders.sort()).toEqual(['finance', 'super_admin']);
  });

  it('keeps catalogue, audit and admin management with super_admin alone', () => {
    const others = permissionsFor(['support', 'moderator', 'finance']);
    for (const permission of ['catalogue.manage', 'audit.read', 'admins.manage'] as const) {
      expect(others).not.toContain(permission);
    }
  });

  it('unions several roles without duplicates, in the canonical order', () => {
    const union = permissionsFor(['finance', 'support', 'finance']);
    expect(new Set(union).size).toBe(union.length);
    expect(union).toEqual(ADMIN_PERMISSIONS.filter((permission) => union.includes(permission)));
    expect(union).toContain('disputes.refund');
    expect(union).toContain('pii.read');
  });

  it('gives an admin with no role nothing', () => {
    expect(permissionsFor([])).toEqual([]);
  });
});

describe('which permission an admin transition needs', () => {
  it('routes the two dispute outcomes to their own permissions', () => {
    expect(permissionForAdminTransition('RESOLVED')).toBe('disputes.resolve');
    expect(permissionForAdminTransition('REFUNDED')).toBe('disputes.refund');
  });

  it('treats every other target as an override', () => {
    expect(permissionForAdminTransition('SEARCHING')).toBe('orders.override');
    expect(permissionForAdminTransition('CANCELLED')).toBe('orders.override');
  });
});

describe('AdminPermissionGuard', () => {
  class Handlers {
    undeclared(): void {}

    @AnyAdmin()
    anyAdmin(): void {}

    @RequireAdminPermission('masters.review')
    review(): void {}
  }

  function admin(permissions: readonly AdminPermission[]): AdminActor {
    return {
      adminUserId: 'a',
      sessionId: 's',
      email: 'a@tezusta.az',
      displayName: 'A',
      roles: [],
      permissions,
    };
  }

  function contextFor(
    handler: keyof Handlers,
    url: string,
    adminActor: AdminActor | undefined,
  ): ExecutionContext {
    return {
      getType: () => 'http',
      // Read as metadata, never called — the guard only reflects on it.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- a metadata key, not a call
      getHandler: () => Handlers.prototype[handler],
      getClass: () => Handlers,
      switchToHttp: () => ({
        getRequest: () => ({ url, method: 'GET', headers: {}, adminActor }),
      }),
    } as unknown as ExecutionContext;
  }

  const guard = new AdminPermissionGuard(new Reflector());

  it('refuses an admin handler that declares nothing, even for a super_admin', () => {
    expect(() =>
      guard.canActivate(contextFor('undeclared', '/admin/x', admin(ADMIN_PERMISSIONS))),
    ).toThrow(InsufficientAdminPermissionError);
  });

  it('lets any admin through @AnyAdmin()', () => {
    expect(guard.canActivate(contextFor('anyAdmin', '/admin/me', admin([])))).toBe(true);
  });

  it('allows the holder of the permission and refuses everyone else', () => {
    expect(guard.canActivate(contextFor('review', '/admin/x', admin(['masters.review'])))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(contextFor('review', '/admin/x', admin(['masters.read']))),
    ).toThrow(InsufficientAdminPermissionError);
  });

  it('refuses when no admin was resolved, whatever the declaration', () => {
    expect(() => guard.canActivate(contextFor('anyAdmin', '/admin/me', undefined))).toThrow(
      InsufficientAdminPermissionError,
    );
  });

  it('does not touch a request outside /admin', () => {
    expect(guard.canActivate(contextFor('undeclared', '/orders', undefined))).toBe(true);
  });
});
