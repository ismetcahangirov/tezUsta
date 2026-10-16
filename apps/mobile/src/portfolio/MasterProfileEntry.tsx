import { skipToken } from '@reduxjs/toolkit/query';

import { Avatar, Card, ChevronRightIcon, ListRow } from '../components';
import { useMasterProfileQuery } from './master-profile-endpoints';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';

export interface MasterProfileEntryProps {
  /** The order's master, or null while nobody has accepted it. */
  readonly masterId: string | null;
  readonly onPress: () => void;
}

/**
 * The order screen's way to the master's profile (ADR-0054 § 4): their avatar,
 * their name, "Profilə bax" and a chevron, in a card.
 *
 * **Drawn only once the profile read has succeeded.** The server alone decides
 * who may see a profile (ADR-0045 § 2), so the row follows its answer: while
 * it loads, after a failure and on a 404 there is no row. A cancellation, a
 * re-dispatch, a closed window or a suspension all remove it without the app
 * knowing which.
 *
 * The read is the same cache entry the profile screen uses, so opening the
 * profile from here draws at once.
 */
export function MasterProfileEntry({
  masterId,
  onPress,
}: MasterProfileEntryProps): React.JSX.Element | null {
  const profile = useMasterProfileQuery(masterId ?? skipToken);
  const shown = profile.currentData;

  if (shown === undefined || profile.error !== undefined) {
    return null;
  }

  return (
    <Card className="py-0">
      <ListRow
        title={shown.displayName}
        titleNumberOfLines={1}
        subtitle={copy.profile.entrySubtitle}
        leading={
          <Avatar
            name={shown.displayName}
            {...(shown.avatarUrl === null ? {} : { uri: shown.avatarUrl })}
            size="sm"
          />
        }
        trailing={<ChevronRightIcon tone="text-muted" />}
        accessibilityLabel={`${shown.displayName}, ${copy.profile.entrySubtitle}`}
        onPress={onPress}
      />
    </Card>
  );
}
