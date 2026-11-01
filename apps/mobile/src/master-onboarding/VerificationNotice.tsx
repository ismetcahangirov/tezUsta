import { Banner, Button } from '../components';
import { useOwnMasterQuery } from '../master-jobs/master-jobs-endpoints';

import { MASTER_ONBOARDING_COPY as copy } from './master-onboarding-copy';

export interface VerificationNoticeProps {
  /** Opens the onboarding screen, at its documents step. */
  readonly onOpen: () => void;
}

/**
 * The master home's way back into an unfinished onboarding (#490).
 *
 * Shown while the profile is `pending_verification` or `changes_requested`:
 * the availability card already says that work waits for verification, and
 * this is where the person goes to add or replace a document. Nothing for an
 * `active`, `rejected` or `suspended` master — the first has nothing to do
 * and the other two have no path the app can offer (ADR-0023).
 */
export function VerificationNotice({ onOpen }: VerificationNoticeProps): React.JSX.Element | null {
  const status = useOwnMasterQuery().currentData?.verificationStatus;

  if (status !== 'pending_verification' && status !== 'changes_requested') {
    return null;
  }

  const changes = status === 'changes_requested';
  return (
    <Banner
      tone={changes ? 'danger' : 'neutral'}
      message={changes ? copy.noticeChangesRequested : copy.noticePending}
      action={<Button label={copy.noticeAction} variant="secondary" size="sm" onPress={onOpen} />}
    />
  );
}
