import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, ProgressBar, StatusPill, Text } from '../../src/components';

/** Master home. Placeholder until availability and matching land (EPIC 7). */
export default function MasterHomeScreen(): React.JSX.Element {
  return (
    <SafeAreaView className="flex-1 bg-bg">
      <View className="gap-6 p-6">
        <Text variant="h1">Bu gün</Text>

        <Card>
          <View className="gap-3">
            <View className="flex-row items-center justify-between">
              <Text variant="body-strong">Profil doğrulaması</Text>
              <StatusPill status="pending" label="Baxılır" />
            </View>
            <ProgressBar accessibilityLabel="Profil doğrulaması" value={2} max={3} />
            <Text variant="caption" tone="muted">
              3 sənəddən 2-si yükləndi
            </Text>
          </View>
        </Card>
      </View>
    </SafeAreaView>
  );
}
