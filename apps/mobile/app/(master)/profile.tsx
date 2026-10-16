import { router, useIsFocused } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OwnProfile } from '../../src/portfolio';

/**
 * The master's own profile and portfolio (#314,
 * [ADR-0054](../../../../docs/decisions/ADR-0054-master-profile-and-portfolio-screens.md)
 * § 1), pushed over home from the avatar in its header (§ 4).
 *
 * The screen is told whether it is in front, so a post that is processing is
 * waited for only while the master is looking at it.
 */
export default function MasterProfileScreen(): React.JSX.Element {
  const focused = useIsFocused();

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <OwnProfile
        focused={focused}
        onNewPost={() => {
          router.push('/(master)/post/new');
        }}
        onBack={() => {
          if (router.canGoBack()) {
            router.back();
          } else {
            router.replace('/(master)');
          }
        }}
      />
    </SafeAreaView>
  );
}
