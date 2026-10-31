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

/**
 * The API's own ceiling on an address (ADR-0072). The API also lowercases
 * it; the page only trims.
 */
const MAX_EMAIL_LENGTH = 254;

/**
 * A light shape check, enough to catch a typo before a round trip. The
 * server's answer is the real check.
 */
function looksLikeEmail(value: string): boolean {
  return value.length <= MAX_EMAIL_LENGTH && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function requestFailureMessage(error: Parameters<typeof describeFailure>[0]): string {
  const failure = describeFailure(error);
  if (failure?.status === 422) return copy.signIn.invalidEmail;
  if (failure?.status === 429) return copy.rateLimited;
  if (failure?.status === 503) return copy.signIn.unavailable;
  return copy.unexpected;
}

function verifyFailureMessage(error: Parameters<typeof describeFailure>[0]): string {
  const failure = describeFailure(error);
  // A wrong code, an expired one, and an address that is not a master's all
  // answer 401, and all read the same (ADR-0061 § 4).
  if (failure?.status === 401 || failure?.status === 422) return copy.signIn.wrongCode;
  if (failure?.status === 429) return copy.rateLimited;
  return copy.unexpected;
}

/**
 * Email address, then the code sent to it (ADR-0061 § 2, ADR-0072 — Email
 * one-time-code sign-in). The code goes only to an active master's address,
 * but the page answers every address the same way, so it never says whether
 * one was sent (§ 4).
 */
export function SignInPage() {
  const dispatch = useAppDispatch();
  const [email, setEmail] = useState('');
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [requestCode, requested] = useRequestCodeMutation();
  const [verifyCode, verified] = useVerifyCodeMutation();

  async function onRequest(event: FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!looksLikeEmail(trimmed)) {
      setEmailInvalid(true);
      return;
    }
    setEmailInvalid(false);
    const result = await requestCode({ email: trimmed });
    if (!('error' in result)) setStep('code');
  }

  async function onVerify(event: FormEvent) {
    event.preventDefault();
    const result = await verifyCode({ email: email.trim(), code: code.trim() });
    if ('error' in result) return;
    // Drop every answer cached while signed out, so the page asks again
    // with the new session's cookies.
    dispatch(webApi.util.resetApiState());
    dispatch(signedIn());
  }

  return (
    <PageFrame>
      <Card>
        <p className="text-lead text-text">{copy.signIn.intro}</p>
        {step === 'email' ? (
          // `noValidate`: the shape check above speaks the page's language,
          // where the browser's own bubble would speak the browser's.
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) => void onRequest(event)}
          >
            {requested.isError && (
              <Banner tone="danger" message={requestFailureMessage(requested.error)} />
            )}
            <TextField
              label={copy.signIn.email}
              hint={copy.signIn.emailHint}
              error={emailInvalid ? copy.signIn.invalidEmail : undefined}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={MAX_EMAIL_LENGTH}
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailInvalid(false);
              }}
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
              label={copy.signIn.changeEmail}
              onClick={() => {
                setCode('');
                verified.reset();
                setStep('email');
              }}
            />
          </form>
        )}
      </Card>
    </PageFrame>
  );
}
