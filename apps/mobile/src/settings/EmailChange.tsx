import type { EmailChangeStarted } from '@tezusta/types';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { isPlausibleEmail, normaliseEmail } from '../auth/email-address';
import { Banner, Button, Text, TextField } from '../components';
import { EMAIL_CHANGE_COPY as copy } from './email-change-copy';
import {
  useConfirmEmailChangeMutation,
  useStartEmailChangeMutation,
} from './email-change-endpoints';
import { emailChangeErrorMessage } from './email-change-errors';

export interface EmailChangeProps {
  /** Leaves the screen without changing anything. */
  readonly onBack: () => void;
}

interface Pending {
  readonly currentEmail: string;
  readonly newEmail: string;
}

/**
 * Changing the address the account signs in with (#516, ADR-0074 § 1).
 *
 * Two steps on one screen: the new address, then the two codes, each field
 * labelled with the address its code went to. Both codes go in together,
 * because the server checks them together.
 *
 * **Nothing navigates on success.** A confirmed change revokes every session
 * (#514); the confirm mutation signs this device out and keeps the new
 * address for sign-in, and the route guard takes the user there.
 *
 * Leaving at any point changes nothing: the pending codes expire on the
 * server, and the account and this session are as they were.
 *
 * **Structure and behaviour only.** Layout and copy are placeholders, the
 * owner's to replace (CLAUDE.md § 17).
 */
export function EmailChange({ onBack }: EmailChangeProps): React.JSX.Element {
  const [address, setAddress] = useState('');
  const [malformed, setMalformed] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [currentCode, setCurrentCode] = useState('');
  const [newCode, setNewCode] = useState('');
  const [resent, setResent] = useState(false);

  const [start, startResult] = useStartEmailChangeMutation();
  const [confirm, confirmResult] = useConfirmEmailChangeMutation();

  async function sendCodes(newEmail: string, isResend: boolean): Promise<void> {
    setResent(false);
    const result = await start({ newEmail });
    if ('error' in result) {
      return;
    }
    setPending(pairFrom(result.data, newEmail));
    setCurrentCode('');
    setNewCode('');
    confirmResult.reset();
    setResent(isResend);
  }

  function submitAddress(): void {
    const normalised = normaliseEmail(address);
    if (!isPlausibleEmail(normalised)) {
      setMalformed(true);
      return;
    }
    void sendCodes(normalised, false);
  }

  const busy = startResult.isLoading || confirmResult.isLoading || confirmResult.isSuccess;

  if (pending === null) {
    const error = malformed
      ? copy.errors.malformed
      : startResult.isError
        ? emailChangeErrorMessage('start', startResult.error)
        : undefined;

    return (
      <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
        <View className="gap-6 p-6 pb-10">
          <Text variant="h1">{copy.title}</Text>
          <Text tone="muted">{copy.addressIntro}</Text>
          <TextField
            label={copy.newEmailLabel}
            placeholder={copy.newEmailPlaceholder}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            value={address}
            editable={!busy}
            onChangeText={(next) => {
              setAddress(next);
              setMalformed(false);
              startResult.reset();
            }}
            {...(error === undefined ? {} : { error })}
          />
          <Button
            label={copy.sendCodes}
            variant="accent"
            fullWidth
            loading={startResult.isLoading}
            disabled={address.trim() === ''}
            onPress={submitAddress}
          />
          <Button label={copy.back} variant="ghost" fullWidth disabled={busy} onPress={onBack} />
        </View>
      </ScrollView>
    );
  }

  const failure = confirmResult.isError
    ? emailChangeErrorMessage('confirm', confirmResult.error)
    : startResult.isError
      ? emailChangeErrorMessage('start', startResult.error)
      : null;

  return (
    <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
      <View className="gap-6 p-6 pb-10">
        <Text variant="h1">{copy.title}</Text>
        <Text tone="muted">{copy.codesIntro}</Text>

        {failure !== null && <Banner tone="danger" message={failure} />}
        {resent && failure === null && <Banner message={copy.resent} />}

        <TextField
          label={copy.codeFor(pending.currentEmail)}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          value={currentCode}
          editable={!busy}
          onChangeText={setCurrentCode}
        />
        <TextField
          label={copy.codeFor(pending.newEmail)}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          value={newCode}
          editable={!busy}
          onChangeText={setNewCode}
        />

        <Button
          label={copy.confirm}
          variant="accent"
          fullWidth
          loading={confirmResult.isLoading || confirmResult.isSuccess}
          disabled={currentCode.trim() === '' || newCode.trim() === '' || busy}
          onPress={() => {
            void confirm({
              currentCode: currentCode.trim(),
              newCode: newCode.trim(),
              newEmail: pending.newEmail,
            });
          }}
        />
        <Button
          label={copy.resend}
          variant="secondary"
          fullWidth
          loading={startResult.isLoading}
          disabled={busy}
          onPress={() => {
            void sendCodes(pending.newEmail, true);
          }}
        />
        <Button
          label={copy.changeAddress}
          variant="ghost"
          fullWidth
          disabled={busy}
          onPress={() => {
            setPending(null);
            setAddress(pending.newEmail);
            startResult.reset();
            confirmResult.reset();
          }}
        />
      </View>
    </ScrollView>
  );
}

function pairFrom(started: EmailChangeStarted, newEmail: string): Pending {
  return { currentEmail: started.currentEmail, newEmail };
}
