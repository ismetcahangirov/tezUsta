import { Stack } from 'expo-router';

import { MasterWorkProvider } from '../../src/master-jobs';
import { useSubscriptionFreshness } from '../../src/master-subscription';

/**
 * The master's tree (ADR-0036).
 *
 * `MasterWorkProvider` sits **above** the stack so that the position reporter,
 * the socket rooms and the background-location session outlive whichever
 * screen is on top — the job screen is where a travelling master looks, and a
 * reporter owned by home would depend on the navigator keeping home mounted
 * underneath it.
 *
 * The subscription's freshness is kept here for the same reason: one listener
 * for the whole tree, whichever screen is on top (#325).
 */
export default function MasterLayout(): React.JSX.Element {
  useSubscriptionFreshness();

  return (
    <MasterWorkProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </MasterWorkProvider>
  );
}
