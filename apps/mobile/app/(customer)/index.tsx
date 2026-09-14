import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, Divider, ListRow, StatusPill, Text } from '../../src/components';

/** Customer home. Placeholder until the service catalogue lands (issue #33). */
export default function CustomerHomeScreen(): React.JSX.Element {
  return (
    <SafeAreaView className="flex-1 bg-bg">
      <View className="gap-6 p-6">
        <Text variant="h1">Nə lazımdır?</Text>

        <Card>
          <View className="flex-row items-center justify-between">
            <Text variant="body-strong">Aktiv sifariş yoxdur</Text>
            <StatusPill status="pending" label="Gözləyir" />
          </View>
        </Card>

        <View>
          <ListRow title="Santexnika" subtitle="Kran, boru, sızma" />
          <Divider />
          <ListRow title="Elektrik" subtitle="Rozetka, işıq, avtomat" />
          <Divider />
          <ListRow title="Kondisioner" subtitle="Quraşdırma və təmir" />
        </View>
      </View>
    </SafeAreaView>
  );
}
