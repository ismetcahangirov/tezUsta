import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useRequestOtpMutation } from '../../src/auth';
import { Button, Text, TextField } from '../../src/components';

/**
 * Sign-in is one of the design system's inverse surfaces — the reference does
 * the same, and it separates "before you are in" from the product itself.
 *
 * **Structure and behaviour only.** The copy, the phone-number mask, the
 * country-code affordance, and what a first-run user is shown before this
 * screen are all owner decisions (CLAUDE.md §17) and are listed on the pull
 * request rather than invented here.
 *
 * The back button the smoke-screen version carried is gone: there is nothing
 * behind this screen any more. The route guard sends every signed-out user
 * here, so `router.back()` would have had nowhere to go.
 */
export default function SignInScreen(): React.JSX.Element {
  const [phone, setPhone] = useState('');
  const [requestOtp, { isLoading, isError }] = useRequestOtpMutation();

  async function submit(): Promise<void> {
    const trimmed = phone.trim();
    if (trimmed === '') {
      return;
    }

    const result = await requestOtp({ phone: trimmed });
    if (!('error' in result)) {
      router.push('/(auth)/verify');
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-inverse-surface dark:bg-bg">
      <View className="flex-1 justify-between p-6">
        <View />

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
            editable={!isLoading}
            onChangeText={setPhone}
            // The server answers identically for a known and an unknown
            // number, so the only thing this can ever report is that the
            // request itself failed. Saying more would invent an oracle the
            // API deliberately does not provide.
            {...(isError ? { error: 'Kod göndərilmədi. Yenidən cəhd edin.' } : {})}
          />
        </View>

        <Button
          label="Kod göndər"
          variant="accent"
          size="lg"
          fullWidth
          loading={isLoading}
          disabled={phone.trim() === ''}
          onPress={() => {
            void submit();
          }}
        />
      </View>
    </SafeAreaView>
  );
}
