import { router, Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NewPost } from '../../../src/portfolio';

/**
 * A new portfolio post (#314, ADR-0054 § 5), pushed over the master's profile.
 *
 * The editor asks before abandoning chosen photos, from its "Geri" and from the
 * hardware back button alike. iOS's swipe back would leave without asking, so
 * it is off here, as it is on the call screens.
 */
export default function NewPostScreen(): React.JSX.Element {
  return (
    <SafeAreaView className="flex-1 bg-bg">
      <Stack.Screen options={{ gestureEnabled: false }} />
      <NewPost
        onClose={() => {
          if (router.canGoBack()) {
            router.back();
          } else {
            router.replace('/(master)/profile');
          }
        }}
      />
    </SafeAreaView>
  );
}
