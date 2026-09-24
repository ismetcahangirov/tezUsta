import type { AdminSetupStart } from '@tezusta/types';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { useSetupCompleteMutation, useSetupStartMutation } from '../api/admin-api';
import { describeFailure } from '../api/api-error';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { QrCode } from '../components/QrCode';
import { TextField } from '../components/TextField';
import { copy } from '../copy';
import { AuthLayout } from './AuthLayout';
import type { SignInNotice } from './SignInPage';

/** The server's bounds (ADR-0043 § 2); the server checks them again. */
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const SIX_DIGITS = /^\d{6}$/;

/**
 * The setup link is `<base>/setup#<token>`: a fragment never reaches a server
 * log. The page reads it once and then removes it from the URL (below), so it
 * lives only in this component's memory — a reload loses it, which is the
 * point.
 */
function readTokenFromUrl(): string | undefined {
  const token = window.location.hash.slice(1);
  return token === '' ? undefined : token;
}

/**
 * Replacing the history entry keeps the token out of the back button, out of
 * a copied address bar and out of anything that later reads `location`. The
 * history state is kept, because the router keeps its own bookkeeping there.
 */
function clearTokenFromUrl(): void {
  if (window.location.hash === '') return;
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`,
  );
}

type Phase =
  | { kind: 'starting' }
  | { kind: 'enrolling'; offer: AdminSetupStart; restarted: boolean }
  | { kind: 'link-invalid' }
  | { kind: 'failed'; message: string };

/**
 * Invitation setup (ADR-0043 § 3): the admin sees which account the link is
 * for, enrols an authenticator from a QR code or the key in text, and sets a
 * password. Nothing is written until the first code from the new
 * authenticator is valid.
 */
export function SetupPage() {
  const navigate = useNavigate();
  // Read once, during the first render — before the effect below clears it.
  const [token] = useState(readTokenFromUrl);
  useEffect(clearTokenFromUrl, []);
  const [start] = useSetupStartMutation();
  const [complete, { isLoading: completing }] = useSetupCompleteMutation();

  const [phase, setPhase] = useState<Phase>(
    token === undefined ? { kind: 'link-invalid' } : { kind: 'starting' },
  );
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string; code?: string }>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const begin = useCallback(
    async (restarted: boolean) => {
      if (token === undefined) return;
      const result = await start({ token });
      if (result.error === undefined) {
        setPhase({ kind: 'enrolling', offer: result.data, restarted });
        return;
      }
      const failure = describeFailure(result.error);
      if (failure?.code === 'ADMIN_SETUP_LINK_INVALID' || failure?.status === 400) {
        setPhase({ kind: 'link-invalid' });
      } else {
        setPhase({
          kind: 'failed',
          message: failure?.status === 429 ? copy.setup.rateLimited : copy.setup.unexpected,
        });
      }
    },
    [start, token],
  );

  // Survives React's development double-mount, so the link is checked once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void begin(false);
  }, [begin]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase.kind !== 'enrolling' || token === undefined) return;

    const next: typeof errors = {};
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      next.password = copy.setup.passwordLength;
    }
    if (confirm !== password) next.confirm = copy.setup.passwordMismatch;
    if (!SIX_DIGITS.test(code)) next.code = copy.setup.codeFormat;
    setErrors(next);
    setFormError(undefined);
    if (Object.keys(next).length > 0) return;

    const result = await complete({
      token,
      password,
      enrolment: phase.offer.enrolment,
      code,
    });
    if (result.error === undefined) {
      const state: SignInNotice = { notice: 'setup-complete' };
      await navigate('/sign-in', { replace: true, state });
      return;
    }

    const failure = describeFailure(result.error);
    if (failure?.code === 'ADMIN_TOTP_CODE_INVALID') {
      setCode('');
      setErrors({ code: copy.setup.codeInvalid });
    } else if (failure?.code === 'ADMIN_SETUP_LINK_INVALID') {
      // The link may still be good and only the offered secret expired (it
      // lives fifteen minutes): ask again. A dead link lands on its own page.
      setCode('');
      await begin(true);
    } else {
      setFormError(failure?.status === 429 ? copy.setup.rateLimited : copy.setup.unexpected);
    }
  }

  if (phase.kind === 'link-invalid') {
    return (
      <AuthLayout title={copy.setup.linkInvalidTitle}>
        <p className="text-body text-text">{copy.setup.linkInvalid}</p>
      </AuthLayout>
    );
  }

  if (phase.kind === 'starting') {
    return (
      <AuthLayout title={copy.setup.title}>
        <p role="status" className="text-body text-text-muted">
          {copy.setup.loading}
        </p>
      </AuthLayout>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <AuthLayout title={copy.setup.title}>
        <Banner tone="danger" message={phase.message} />
      </AuthLayout>
    );
  }

  const { offer } = phase;
  return (
    <AuthLayout title={copy.setup.title}>
      {phase.restarted && <Banner message={copy.setup.restarted} />}
      {formError !== undefined && <Banner tone="danger" message={formError} />}

      <section className="flex flex-col gap-1">
        <h2 className="text-caption text-text-muted">{copy.setup.account}</h2>
        <p className="text-body-strong font-bold text-text">{offer.displayName}</p>
        <p className="text-body text-text">{offer.email}</p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-h2 font-bold text-text">{copy.setup.scanTitle}</h2>
        <p className="text-caption text-text-muted">{copy.setup.scanHint}</p>
        <div className="self-start">
          <QrCode value={offer.otpauthUri} label={copy.setup.qrLabel} />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-caption text-text-muted" id="setup-key-label">
            {copy.setup.secretLabel}
          </p>
          <code
            aria-labelledby="setup-key-label"
            className="select-all break-all rounded-sm bg-surface-alt px-3 py-2 font-mono text-body text-text"
          >
            {offer.totpSecret}
          </code>
        </div>
      </section>

      <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void submit(event)}>
        {/* Lets a password manager file the new password under the right account. */}
        <input type="hidden" name="username" autoComplete="username" value={offer.email} />
        <TextField
          label={copy.setup.password}
          hint={copy.setup.passwordHint}
          error={errors.password}
          type="password"
          name="new-password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <TextField
          label={copy.setup.confirmPassword}
          error={errors.confirm}
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        <TextField
          label={copy.setup.code}
          error={errors.code}
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
          label={copy.setup.submit}
          loadingLabel={copy.setup.submitting}
          loading={completing}
        />
      </form>
    </AuthLayout>
  );
}
