import { Pressable, View } from 'react-native';

import { Avatar } from '../components';
import { useOwnMasterQuery } from '../master-jobs/master-jobs-endpoints';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';

export interface OwnProfileEntryProps {
  readonly onPress: () => void;
}

/**
 * The master's way to their own profile (ADR-0054 § 4): their avatar at
 * `avatar-md` (44, the touch target) in the home header, left of settings,
 * labelled "Profilim". When the master gets a tab bar (ADR-0036), the profile
 * becomes a tab and this control goes.
 *
 * Drawn once the master is known, since the initials need a name; until then
 * an empty space of the same size keeps the header from shifting.
 */
export function OwnProfileEntry({ onPress }: OwnProfileEntryProps): React.JSX.Element {
  const own = useOwnMasterQuery();
  const master = own.currentData;

  if (master === undefined) {
    return <View className="h-avatar-md w-avatar-md" />;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copy.own.title}
      onPress={onPress}
      className="active:opacity-80"
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Avatar
          name={master.displayName}
          {...(master.avatarUrl === null ? {} : { uri: master.avatarUrl })}
          size="md"
        />
      </View>
    </Pressable>
  );
}
