import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useRef, useState } from 'react';
import { type TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { canPickGoogleAccount, pickGoogleAccount } from '../../modules/google-account-picker';
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
 *
 * On Android the field's first tap shows the phone's Google accounts before
 * the keyboard (#510). Picking one only fills the field: the code still goes
 * to the address by email, and nothing signs in with Google (ADR-0072).
 */
export default function SignInScreen(): React.JSX.Element {
  const [email, setEmail] = useState('');
  // Set by a submit the shape check refused, and cleared by the next edit — an
  // error that stays up while the user is fixing the address reads as though
  // the fix did not take.
  const [malformed, setMalformed] = useState(false);
  const [requestOtp, { isLoading, isError }] = useRequestOtpMutation();
  const field = useRef<TextInput>(null);
  // Once per visit: a user who backed out, or is correcting the address, is
  // typing, and the chooser coming back on every tap would be in their way.
  const offeredAccounts = useRef(false);

  function offerAccounts(): void {
    if (offeredAccounts.current || email !== '' || !canPickGoogleAccount()) {
      return;
    }
    offeredAccounts.current = true;
    // The chooser covers the screen; a keyboard left up under it would
    // still be there, over nothing, once it closes.
    field.current?.blur();
    void pickGoogleAccount().then((picked) => {
      if (picked === null) {
        field.current?.focus();
        return;
      }
      setEmail(picked);
      setMalformed(false);
    });
  }

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
      {/* Dark in both schemes, so the status bar is light in both: the root
          layout's scheme-following bar would draw dark icons on this surface. */}
      <StatusBar style="light" />
      <View className="flex-1 justify-between p-6">
        <View className="items-center pt-6">
          <Wordmark tone="on-accent" width={160} />
        </View>

        <View className="gap-6">
          <Text variant="h1" tone="on-inverse" className="dark:text-text">
            E-poçt ünvanınızı daxil edin
          </Text>
          <TextField
            ref={field}
            label="E-poçt ünvanı"
            placeholder="ad@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            value={email}
            editable={!isLoading}
            onFocus={offerAccounts}
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
