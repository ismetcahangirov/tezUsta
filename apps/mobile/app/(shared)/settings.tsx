import { SafeAreaView } from 'react-native-safe-area-context';

import { Settings } from '../../src/settings';

/**
 * Settings, as the **master** reaches it — pushed from their home screen
 * ([ADR-0031](../../../../docs/decisions/ADR-0031-where-settings-is-reached-from.md),
 * issue #164).
 *
 * It stays in `(shared)` rather than moving under `(master)/` because the
 * screen belongs to both roles and the route guard already treats this group as
 * visitable from either (`route-guard.ts`). The customer reaches the same
 * component through their own tab; `src/settings/Settings.tsx` explains why one
 * screen needs two routes.
 */
export default function SettingsScreen(): React.JSX.Element {
  return (
    <SafeAreaView className="flex-1 bg-bg">
      <Settings />
    </SafeAreaView>
  );
}
