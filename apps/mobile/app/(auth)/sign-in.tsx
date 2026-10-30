import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isPlausibleEmail, normaliseEmail, useRequestOtpMutation } from '../../src/auth';
import { Button, Text, TextField, Wordmark } from '../../src/components';

/**
 * Sign-in is one of the design system's inverse surfaces — the reference does
 * the same, and it separates "before you are in" from the product itself.
 *
 * The address is the only way in (ADR-0072): the code goes to it by email, and
 * there is no phone number anywhere in the account.
 *
 * **Structure and behaviour only.** The copy and what a first-run user is shown
 * before this screen are owner decisions (CLAUDE.md §17) and are listed on the
 * pull request rather than invented here.
 *
 * The back button the smoke-screen version carried is gone: there is nothing
 * behind this screen any more. The route guard sends every signed-out user
 * here, so `router.back()` would have had nowhere to go.
 */
export default function SignInScreen(): React.JSX.Element {
  const [email, setEmail] = useState('');
  // Set by a submit the shape check refused, and cleared by the next edit — an
  // error that stays up while the user is fixing the address reads as though
  // the fix did not take.
  const [malformed, setMalformed] = useState(false);
  const [requestOtp, { isLoading, isError }] = useRequestOtpMutation();

  async function submit(): Promise<void> {
    const normalised = normaliseEmail(email);
    if (normalised === '') {
      return;
    }
    if (!isPlausibleEmail(normalised)) {
      setMalformed(true);
      return;
    }

    const result = await requestOtp({ email: normalised });
    if (!('error' in result)) {
      router.push('/(auth)/verify');
    }
  }

  // The server answers identically for a known and an unknown address, so the
  // only thing a sent request can ever report is that the request itself
  // failed. Saying more would invent an oracle the API deliberately does not
  // provide.
  const error = malformed
    ? 'E-poçt ünvanı düzgün deyil.'
    : isError
      ? 'Kod göndərilmədi. Yenidən cəhd edin.'
      : undefined;

  return (
    <SafeAreaView className="flex-1 bg-inverse-surface dark:bg-bg">
      <View className="flex-1 justify-between p-6">
        <View className="items-center pt-6">
          <Wordmark tone="on-accent" width={160} />
        </View>

        <View className="gap-6">
          <Text variant="h1" tone="on-inverse" className="dark:text-text">
            E-poçt ünvanınızı daxil edin
          </Text>
          <TextField
            label="E-poçt ünvanı"
            placeholder="ad@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            value={email}
            editable={!isLoading}
            onChangeText={(next) => {
              setEmail(next);
              setMalformed(false);
            }}
            {...(error === undefined ? {} : { error })}
          />
        </View>

        <Button
          label="Kod göndər"
          variant="accent"
          size="lg"
          fullWidth
          loading={isLoading}
          disabled={email.trim() === ''}
          onPress={() => {
            void submit();
          }}
        />
      </View>
    </SafeAreaView>
  );
}
