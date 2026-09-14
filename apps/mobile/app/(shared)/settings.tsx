import { useColorScheme } from 'nativewind';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SegmentedControl, Text } from '../../src/components';

const SCHEMES = [
  { value: 'light', label: 'İşıqlı' },
  { value: 'dark', label: 'Qaranlıq' },
  { value: 'system', label: 'Sistem' },
] as const;

type SchemeChoice = (typeof SCHEMES)[number]['value'];

/** Settings. For now it does one real thing: switch the theme. */
export default function SettingsScreen(): React.JSX.Element {
  // Kept as an object rather than destructured: `setColorScheme` is typed as a
  // method, and pulling it out detaches it from its receiver.
  const scheme = useColorScheme();

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <View className="gap-6 p-6">
        <Text variant="h1">Tənzimləmələr</Text>
        <View className="gap-2">
          <Text variant="caption" tone="muted">
            Görünüş
          </Text>
          <SegmentedControl
            items={[...SCHEMES]}
            value={scheme.colorScheme ?? 'system'}
            onChange={(choice: SchemeChoice) => {
              scheme.setColorScheme(choice);
            }}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}
