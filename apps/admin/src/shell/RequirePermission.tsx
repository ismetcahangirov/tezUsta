import type { AdminPermission } from '@tezusta/types';
import type { ReactNode } from 'react';

import { copy } from '../copy';
import { PageFrame } from './PageFrame';

export interface RequirePermissionProps {
  permission: AdminPermission;
  granted: readonly AdminPermission[];
  children: ReactNode;
}

/**
 * Renders the page only for an admin who holds `permission`, and a plain "no
 * access" state otherwise — reached by typing a URL the navigation did not
 * offer. This is presentation, not protection: every request the page makes
 * is refused by the server regardless (ADR-0043 § 1).
 */
export function RequirePermission({ permission, granted, children }: RequirePermissionProps) {
  if (granted.includes(permission)) return children;
  return (
    <PageFrame title={copy.shell.noAccessTitle}>
      <p className="text-body text-text-muted">{copy.shell.noAccess}</p>
    </PageFrame>
  );
}
