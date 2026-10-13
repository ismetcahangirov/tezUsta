import type { AdminAccountStatus } from '@tezusta/types';

import { customersCopy } from './copy';

const TONE: Record<AdminAccountStatus, string> = {
  active: 'bg-inverse-surface text-on-inverse',
  suspended: 'bg-danger text-on-danger',
  deleted: 'bg-surface-alt text-text-muted',
};

/** An account's status as a pill — the same tones the master badge uses for the same states. */
export function CustomerStatusBadge({ status }: { status: AdminAccountStatus }) {
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-caption font-bold ${TONE[status]}`}
    >
      {customersCopy.status[status]}
    </span>
  );
}
