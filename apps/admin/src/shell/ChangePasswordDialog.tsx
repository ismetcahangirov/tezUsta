import { type FormEvent, useState } from 'react';

import { useChangePasswordMutation } from '../api/admin-api';
import { describeFailure } from '../api/api-error';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { TextField } from '../components/TextField';
import { copy } from '../copy';

/** The server's bounds (ADR-0043 § 2); the server checks them again. */
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const SIX_DIGITS = /^\d{6}$/;

interface FieldErrors {
  current?: string;
  next?: string;
  confirm?: string;
  code?: string;
}

/**
 * Changes the signed-in admin's own password (#329): the current password
 * and a fresh code, never the session alone. The passwords live in this
 * dialog's state, and in the mutation's arguments only until it answers —
 * `reset()` drops them from the store then, and closing the dialog unmounts
 * the rest.
 */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const text = copy.passwordChange;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);
  const [change, { isLoading, reset }] = useChangePasswordMutation();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: FieldErrors = {};
    if (current === '') found.current = text.currentEmpty;
    if (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX) found.next = text.passwordLength;
    if (confirm !== next) found.confirm = text.passwordMismatch;
    if (!SIX_DIGITS.test(code)) found.code = text.codeFormat;
    setErrors(found);
    setFormError(undefined);
    if (Object.keys(found).length > 0) return;

    const result = await change({ currentPassword: current, newPassword: next, code });
    // Read, then dropped: the passwords are the mutation's arguments.
    reset();
    if (result.error === undefined) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
      return;
    }
    const failure = describeFailure(result.error);
    // A refused code is spent or stale either way: ask for a fresh one.
    setCode('');
    setFormError(
      failure?.code === 'ADMIN_CREDENTIALS_INVALID'
        ? text.invalid
        : failure?.status === 429
          ? text.rateLimited
          : text.unexpected,
    );
  }

  if (done) {
    return (
      <Dialog title={text.title} onClose={onClose}>
        <Banner message={text.done} />
        <div className="flex justify-end">
          <Button label={text.close} onClick={onClose} />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={text.title} onClose={onClose}>
      <form noValidate className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <p className="text-body text-text-muted">{text.intro}</p>
        {formError !== undefined && <Banner tone="danger" message={formError} />}
        <TextField
          label={text.current}
          error={errors.current}
          type="password"
          name="current-password"
          autoComplete="current-password"
          maxLength={PASSWORD_MAX}
          required
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
        <TextField
          label={text.next}
          hint={text.nextHint}
          error={errors.next}
          type="password"
          name="new-password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          required
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
        <TextField
          label={text.confirm}
          error={errors.confirm}
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        <TextField
          label={text.code}
          error={errors.code}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
        />
        <div className="flex justify-end gap-2">
          <Button label={text.cancel} variant="secondary" disabled={isLoading} onClick={onClose} />
          <Button
            type="submit"
            label={text.submit}
            loadingLabel={text.submitting}
            loading={isLoading}
          />
        </div>
      </form>
    </Dialog>
  );
}
