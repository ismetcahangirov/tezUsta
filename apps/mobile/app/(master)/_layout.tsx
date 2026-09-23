import { Stack } from 'expo-router';

import { MasterWorkProvider } from '../../src/master-jobs';

/**
 * The master's tree (ADR-0036).
 *
 * `MasterWorkProvider` sits **above** the stack so that the position reporter,
 * the socket rooms and the background-location session outlive whichever
 * screen is on top — the job screen is where a travelling master looks, and a
 * reporter owned by home would depend on the navigator keeping home mounted
 * underneath it.
 */
export default function MasterLayout(): React.JSX.Element {
  return (
    <MasterWorkProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </MasterWorkProvider>
  );
}
