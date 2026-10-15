import { type FormEvent, type ReactNode, useState } from 'react';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { portfolioCopy } from './copy';

/**
 * A removal with a mandatory reason, checked as the API will check it. Shared
 * by a post's removal and an avatar's: both are a reason, a confirm, and an
 * error banner if the server refused.
 */
export function RemovalDialog({
  title,
  hint,
  confirm,
  failed,
  isLoading,
  isError,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  hint: string;
  confirm: string;
  failed: string;
  isLoading: boolean;
  isError: boolean;
  onSubmit: (reason: string) => Promise<boolean>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const text = portfolioCopy.removal;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = reasonProblem(reason);
    setReasonError(
      problem === 'empty'
        ? text.reasonEmpty
        : problem === 'tooLong'
          ? text.reasonTooLong
          : undefined,
    );
    if (problem !== undefined) return;
    if (await onSubmit(reason.trim())) onClose();
  }

  return (
    <Dialog title={title} onClose={onClose}>
      <form noValidate className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {isError && <Banner tone="danger" message={failed} />}
        {children}
        <ReasonField
          label={text.reason}
          hint={hint}
          value={reason}
          error={reasonError}
          disabled={isLoading}
          onChange={setReason}
        />
        <div className="flex justify-end gap-2">
          <Button label={text.cancel} variant="secondary" onClick={onClose} />
          <Button
            type="submit"
            label={confirm}
            loadingLabel={text.confirming}
            loading={isLoading}
          />
        </div>
      </form>
    </Dialog>
  );
}
