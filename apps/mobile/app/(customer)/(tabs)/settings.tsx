import { SafeAreaView } from 'react-native-safe-area-context';

import { Settings } from '../../../src/settings';

/**
 * The customer's third tab
 * ([ADR-0031](../../../../docs/decisions/ADR-0031-where-settings-is-reached-from.md),
 * issue #164).
 *
 * Until this route existed, `(shared)/settings` was linked from nowhere: the
 * notification preferences of #147, the saved addresses of #90 and both
 * sign-out controls were reachable only by typing a path, which on a phone
 * means not at all.
 *
 * The same component the master's `(shared)/settings` route renders — a tab can
 * only name a route inside its own directory, so a screen that is a tab for one
 * role and a pushed screen for the other is a component with two routes rather
 * than one route with two parents.
 *
 * `edges={['top']}` because the tab bar already owns the bottom inset.
 */
export default function CustomerSettingsScreen(): React.JSX.Element {
  return (
    <SafeAreaView className="flex-1 bg-bg" edges={['top']}>
      <Settings />
    </SafeAreaView>
  );
}
