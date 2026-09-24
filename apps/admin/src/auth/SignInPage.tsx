import { type FormEvent, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useSignInMutation } from '../api/admin-api';
import { describeFailure } from '../api/api-error';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { copy } from '../copy';
import { useAppDispatch, useAppSelector } from '../hooks';
import { signedIn } from '../session/session-slice';
import { AuthLayout } from './AuthLayout';

const SIX_DIGITS = /^\d{6}$/;

/** What another page can tell the sign-in page when it sends the admin here. */
export interface SignInNotice {
  readonly notice?: 'setup-complete';
}

function readNotice(state: unknown): SignInNotice['notice'] {
  if (typeof state === 'object' && state !== null && 'notice' in state) {
    return state.notice === 'setup-complete' ? 'setup-complete' : undefined;
  }
  return undefined;
}

/**
 * Email, password and authenticator code in one request (ADR-0043 § 4). Any
 * credential failure is one message: the server does not say which factor was
 * wrong, and neither does the page.
 */
export function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useAppDispatch();
  const sessionEnded = useAppSelector((state) => state.session.signedOut);
  const [signIn, { isLoading, error }] = useSignInMutation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | undefined>(undefined);

  const notice = readNotice(location.state);
  const failure = describeFailure(error);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!SIX_DIGITS.test(code)) {
      setCodeError(copy.signIn.codeFormat);
      return;
    }
    setCodeError(undefined);
    const result = await signIn({ email: email.trim(), password, code });
    if (result.error === undefined) {
      dispatch(signedIn());
      await navigate('/', { replace: true });
    } else {
      // A code is single-use once accepted, and a rejected one is rarely
      // worth retyping: clear it so the next attempt starts from a fresh one.
      setCode('');
    }
  }

  let message: string | undefined;
  if (failure !== undefined) {
    if (failure.status === 401) message = copy.signIn.failed;
    else if (failure.status === 429) message = copy.signIn.rateLimited;
    // A 400 is a body the schema refused — for this form, a credential that
    // cannot be right. Same message: the page never says which factor.
    else if (failure.status === 400) message = copy.signIn.failed;
    else message = copy.signIn.unexpected;
  }

  return (
    <AuthLayout title={copy.signIn.title}>
      {message !== undefined && <Banner tone="danger" message={message} />}
      {message === undefined && notice === 'setup-complete' && (
        <Banner message={copy.signIn.setupComplete} />
      )}
      {message === undefined && notice === undefined && sessionEnded && (
        <Banner message={copy.signIn.sessionEnded} />
      )}
      <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void submit(event)}>
        <TextField
          label={copy.signIn.email}
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          label={copy.signIn.password}
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <TextField
          label={copy.signIn.code}
          hint={copy.signIn.codeHint}
          error={codeError}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
        />
        <Button
          type="submit"
          variant="accent"
          label={copy.signIn.submit}
          loadingLabel={copy.signIn.submitting}
          loading={isLoading}
          disabled={email.trim() === '' || password === ''}
        />
      </form>
    </AuthLayout>
  );
}
