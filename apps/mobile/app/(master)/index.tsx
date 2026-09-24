import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconButton, SettingsIcon, Text } from '../../src/components';
import { AvailabilityCard } from '../../src/master-availability';
import { MasterWork } from '../../src/master-jobs';
import { SETTINGS_COPY } from '../../src/settings';

/**
 * Master home.
 *
 * The placeholder verification card that stood here is gone: it rendered a
 * hard-coded "2 of 3 documents uploaded" that was true of nobody, and a screen
 * showing invented numbers to a master waiting on a real review is worse than
 * a screen showing less. Wiring that panel to `GET /masters/me/documents`
 * belongs with the rest of the mobile verification flow, which no issue has
 * asked for yet.
 *
 * What is here is real: the availability toggle (issue #40), reading and
 * writing the server's own state — and, under it since issue #199, the work
 * itself: the job the master is on, or the offers dispatch is sending them
 * ([ADR-0036](../../../docs/decisions/ADR-0036-master-work-surface.md)).
 *
 * **And, since issue #164, the way to settings** — which is to say the way to
 * sign out, to change the appearance, to switch role, and to turn a
 * notification category off. None of that was reachable from any screen before
 * ([ADR-0031](../../../docs/decisions/ADR-0031-where-settings-is-reached-from.md)).
 *
 * A control in the title row rather than a tab, because the master's root is
 * still a single stack (ADR-0030 § 2): a tab bar with one destination and a
 * settings tab would be a bar about settings. When the job list gives this tree
 * a bar of its own, settings becomes its third tab, exactly as the customer's
 * is, and this control goes away.
 */
export default function MasterHomeScreen(): React.JSX.Element {
  return (
    <SafeAreaView className="flex-1 bg-bg">
      <ScrollView className="flex-1">
        <View className="gap-6 p-6">
          <View className="flex-row items-center justify-between">
            <Text variant="h1">Bu gün</Text>
            <IconButton
              accessibilityLabel={SETTINGS_COPY.openLabel}
              icon={<SettingsIcon tone="on-inverse" />}
              onPress={() => {
                router.push('/(shared)/settings');
              }}
            />
          </View>

          <AvailabilityCard />

          <MasterWork
            onOpenJob={() => {
              router.push('/(master)/job');
            }}
            onOpenReview={(orderId) => {
              router.push({ pathname: '/(master)/review/[orderId]', params: { orderId } });
            }}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
