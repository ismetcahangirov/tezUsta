import { type FormEvent, useState } from 'react';

import { describeFailure } from '../api/api-error';
import { useRequestCodeMutation, useVerifyCodeMutation, webApi } from '../api/web-api';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { copy } from '../copy';
import { useAppDispatch } from '../hooks';
import { signedIn } from '../session/session-slice';
import { Card, PageFrame } from './PageFrame';

function requestFailureMessage(error: Parameters<typeof describeFailure>[0]): string {
  const failure = describeFailure(error);
  if (failure?.status === 422) return copy.signIn.invalidPhone;
  if (failure?.status === 429) return copy.rateLimited;
  if (failure?.status === 503) return copy.signIn.unavailable;
  return copy.unexpected;
}

function verifyFailureMessage(error: Parameters<typeof describeFailure>[0]): string {
  const failure = describeFailure(error);
  // A wrong code, an expired one, and a phone that is not a master's all
  // answer 401, and all read the same (ADR-0061 § 4).
  if (failure?.status === 401 || failure?.status === 422) return copy.signIn.wrongCode;
  if (failure?.status === 429) return copy.rateLimited;
  return copy.unexpected;
}

/**
 * Phone, then the SMS code (ADR-0061 § 2). The code goes only to an active
 * master's phone, but the page answers every phone the same way, so it never
 * says whether one was sent (§ 4).
 */
export function SignInPage() {
  const dispatch = useAppDispatch();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [requestCode, requested] = useRequestCodeMutation();
  const [verifyCode, verified] = useVerifyCodeMutation();

  async function onRequest(event: FormEvent) {
    event.preventDefault();
    const result = await requestCode({ phone: phone.trim() });
    if (!('error' in result)) setStep('code');
  }

  async function onVerify(event: FormEvent) {
    event.preventDefault();
    const result = await verifyCode({ phone: phone.trim(), code: code.trim() });
    if ('error' in result) return;
    // Drop every answer cached while signed out, so the page asks again
    // with the new session's cookies.
    dispatch(webApi.util.resetApiState());
    dispatch(signedIn());
  }

  return (
    <PageFrame>
      <Card>
        <p className="text-body text-text">{copy.signIn.intro}</p>
        {step === 'phone' ? (
          <form className="flex flex-col gap-4" onSubmit={(event) => void onRequest(event)}>
            {requested.isError && (
              <Banner tone="danger" message={requestFailureMessage(requested.error)} />
            )}
            <TextField
              label={copy.signIn.phone}
              hint={copy.signIn.phoneHint}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
            <Button
              type="submit"
              label={copy.signIn.sendCode}
              loadingLabel={copy.signIn.sending}
              loading={requested.isLoading}
            />
          </form>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(event) => void onVerify(event)}>
            {verified.isError ? (
              <Banner tone="danger" message={verifyFailureMessage(verified.error)} />
            ) : (
              <Banner message={copy.signIn.codeSent} />
            )}
            <TextField
              label={copy.signIn.code}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button
              type="submit"
              label={copy.signIn.verify}
              loadingLabel={copy.signIn.verifying}
              loading={verified.isLoading}
            />
            <Button
              variant="ghost"
              label={copy.signIn.changePhone}
              onClick={() => {
                setCode('');
                verified.reset();
                setStep('phone');
              }}
            />
          </form>
        )}
      </Card>
    </PageFrame>
  );
}
