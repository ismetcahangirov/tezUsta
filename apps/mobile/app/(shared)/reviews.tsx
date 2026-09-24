import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ReceivedReviews } from '../../src/reviews';
import { useAppSelector } from '../../src/store/hooks';
import { selectRole } from '../../src/store/session-slice';

/**
 * "Reviews about me" (issue #228, ADR-0042 § 6), pushed from settings.
 *
 * In `(shared)` for the reason settings is: both roles reach it, and the
 * route guard treats this group as visitable from either. It shows the
 * reviews for **the role on screen** — a person who is both customer and
 * master sees the other set by switching role, never the two mixed.
 */
export default function ReceivedReviewsScreen(): React.JSX.Element {
  const role = useAppSelector(selectRole);

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <ReceivedReviews
        role={role}
        onBack={() => {
          if (router.canGoBack()) {
            router.back();
          } else {
            router.replace('/(shared)/settings');
          }
        }}
      />
    </SafeAreaView>
  );
}
