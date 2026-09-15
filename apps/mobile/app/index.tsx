import { router } from 'expo-router';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, SegmentedControl, Text } from '../src/components';
import { useAppDispatch, useAppSelector } from '../src/store/hooks';
import { roleSelected, selectRole, type AppRole } from '../src/store/session-slice';

const ROLES: { value: AppRole; label: string }[] = [
  { value: 'customer', label: 'Müştəri' },
  { value: 'master', label: 'Usta' },
];

/**
 * Foundation smoke screen. It exists to prove the shell works end to end —
 * fonts, tokens, routing, state — and will be replaced by the real entry flow
 * once authentication lands (issue #30).
 */
export default function IndexScreen(): React.JSX.Element {
  const role = useAppSelector(selectRole);
  const dispatch = useAppDispatch();

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <View className="flex-1 justify-between p-6">
        <View className="gap-4">
          <Text variant="display">TezUsta</Text>
          <Text tone="muted">Usta lazımdır — indi.</Text>
        </View>

        <View className="gap-4">
          <SegmentedControl
            items={ROLES}
            value={role}
            onChange={(next) => dispatch(roleSelected(next))}
          />
          <Button
            label="Davam et"
            fullWidth
            size="lg"
            onPress={() => {
              router.push(role === 'master' ? '/(master)' : '/(customer)');
            }}
          />
          <Button
            label="Daxil ol"
            variant="ghost"
            fullWidth
            onPress={() => {
              router.push('/(auth)/sign-in');
            }}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}
