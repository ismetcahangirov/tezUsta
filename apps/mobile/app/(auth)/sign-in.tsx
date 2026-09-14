import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, IconButton, Text, TextField } from '../../src/components';
import { ChevronLeftIcon } from '../../src/components/icons';

/**
 * Sign-in is one of the design system's inverse surfaces — the reference does
 * the same, and it separates "before you are in" from the product itself.
 *
 * Structure only: the OTP request is issue #30, and is blocked on the SMS
 * provider decision (CLAUDE.md §1).
 */
export default function SignInScreen(): React.JSX.Element {
  const [phone, setPhone] = useState('');

  return (
    <SafeAreaView className="flex-1 bg-inverse-surface dark:bg-bg">
      <View className="flex-1 justify-between p-6">
        <View className="flex-row">
          <IconButton
            accessibilityLabel="Geri"
            variant="surface"
            icon={<ChevronLeftIcon />}
            onPress={() => {
              router.back();
            }}
          />
        </View>

        <View className="gap-6">
          <Text variant="h1" tone="on-inverse" className="dark:text-text">
            Nömrənizi daxil edin
          </Text>
          <TextField
            label="Telefon nömrəsi"
            placeholder="+994 __ ___ __ __"
            keyboardType="phone-pad"
            autoComplete="tel"
            value={phone}
            onChangeText={setPhone}
          />
        </View>

        <Button label="Kod göndər" variant="accent" size="lg" fullWidth disabled={phone === ''} />
      </View>
    </SafeAreaView>
  );
}
