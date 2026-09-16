import { Redirect } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AUTH_ENTRY_ROUTE, useVerifyOtpMutation } from '../../src/auth';
import { Button, Text, TextField } from '../../src/components';
import { useAppSelector } from '../../src/store/hooks';
import { selectOtpRequestedFor } from '../../src/store/session-slice';

/**
 * The second half of sign-in: the code that proves the number is the user's.
 *
 * Nothing here navigates on success. Verifying stores the token pair and moves
 * the session to `signed-in`, and the route guard in the root layout takes the
 * user out of `(auth)` from there — one place decides where a signed-in user
 * belongs, rather than every screen that could create a session.
 *
 * **Structure and behaviour only.** The code length, whether the boxes are
 * separate digits, the resend affordance and its countdown, and the copy are
 * owner decisions (CLAUDE.md §17) and are listed on the pull request.
 */
export default function VerifyScreen(): React.JSX.Element {
  const phone = useAppSelector(selectOtpRequestedFor);
  const [code, setCode] = useState('');
  const [verifyOtp, { isLoading, isError }] = useVerifyOtpMutation();

  if (phone === null) {
    // Reached by a deep link, or after a reload that dropped the pending
    // number. There is no code to verify without knowing what it was sent to.
    return <Redirect href={AUTH_ENTRY_ROUTE} />;
  }

  return (
    <SafeAreaView className="flex-1 bg-inverse-surface dark:bg-bg">
      <View className="flex-1 justify-between p-6">
        <View />

        <View className="gap-6">
          <Text variant="h1" tone="on-inverse" className="dark:text-text">
            Kodu daxil edin
          </Text>
          <TextField
            label="SMS kodu"
            keyboardType="number-pad"
            autoComplete="sms-otp"
            textContentType="oneTimeCode"
            value={code}
            editable={!isLoading}
            onChangeText={setCode}
            // One message for every failure. The server does not distinguish a
            // wrong code from a spent one in its response, and neither may
            // this screen (docs/architecture/authentication.md § Rate limiting).
            {...(isError ? { error: 'Kod düzgün deyil və ya vaxtı bitib.' } : {})}
          />
        </View>

        <Button
          label="Təsdiqlə"
          variant="accent"
          size="lg"
          fullWidth
          loading={isLoading}
          disabled={code.trim() === ''}
          onPress={() => {
            void verifyOtp({ phone, code: code.trim() });
          }}
        />
      </View>
    </SafeAreaView>
  );
}
