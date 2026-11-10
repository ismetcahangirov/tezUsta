import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EmailChange } from '../../src/settings';

/**
 * Changing the sign-in address (#516), pushed from Settings → Hesab. In
 * `(shared)` because both roles reach Settings and both have an address.
 */
export default function EmailChangeScreen(): React.JSX.Element {
  const router = useRouter();

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <EmailChange onBack={() => router.back()} />
    </SafeAreaView>
  );
}
