import type { MasterVerificationStatus } from '@tezusta/types';

import { mastersCopy } from './copy';

const TONE: Record<MasterVerificationStatus, string> = {
  pending_verification: 'bg-accent text-on-accent',
  changes_requested: 'bg-surface-alt text-text',
  rejected: 'bg-surface-alt text-text-muted',
  active: 'bg-inverse-surface text-on-inverse',
  suspended: 'bg-danger text-on-danger',
};

/**
 * A master's verification status as a pill. The accent marks what is waiting
 * for a reviewer; `danger` marks a suspension — the two an admin scans for.
 */
export function MasterStatusBadge({ status }: { status: MasterVerificationStatus }) {
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-caption font-bold ${TONE[status]}`}
    >
      {mastersCopy.status[status]}
    </span>
  );
}
