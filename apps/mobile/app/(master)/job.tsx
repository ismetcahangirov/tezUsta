import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { JobDetail } from '../../src/master-jobs';

/**
 * The job the master is on (issue #199, ADR-0036).
 *
 * No `[id]`: a master holds at most one job, and the screen reads it from
 * `GET /masters/me/jobs/current` rather than being told which order to show —
 * so a stale link cannot open an order that is no longer theirs.
 */
export default function JobScreen(): React.JSX.Element {
  return (
    <SafeAreaView className="flex-1 bg-bg">
      <JobDetail
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
