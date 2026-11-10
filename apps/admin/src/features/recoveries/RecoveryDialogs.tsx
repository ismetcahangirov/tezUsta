import type { AdminAccountRecoveryEmails } from '@tezusta/types';
import { useState } from 'react';

import { type ApiFailure, describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { useAppDispatch } from '../../hooks';
import { recoveriesApi } from './api';
import { recoveriesCopy, recoveryErrorMessage } from './copy';

export interface ReasonDialogProps {
  title: string;
  body: string;
  hint: string;
  submitLabel: string;
  submittingLabel: string;
  /** Resolves to the failure, or `undefined` when the step was done. */
  onSubmit: (reason: string) => Promise<ApiFailure | undefined>;
  onClose: () => void;
  onDone: () => void;
}

/** Cancel and approve: a required reason, kept in the audit log, and the server's refusal in words. */
export function ReasonDialog({
  title,
  body,
  hint,
  submitLabel,
  submittingLabel,
  onSubmit,
  onClose,
  onDone,
}: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | undefined | null>(null);

  const problem = reasonProblem(reason);
  const reasonError =
    touched && problem !== undefined
      ? problem === 'empty'
        ? recoveriesCopy.reasonEmpty
        : recoveriesCopy.reasonTooLong
      : undefined;

  async function submit() {
    setTouched(true);
    if (problem !== undefined) return;
    setBusy(true);
    setFailure(null);
    const refused = await onSubmit(reason.trim());
    setBusy(false);
    if (refused === undefined) {
      onDone();
      return;
    }
    setFailure(refused);
  }

  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="text-body text-text">{body}</p>
        <ReasonField
          label={recoveriesCopy.reasonLabel}
          hint={hint}
          value={reason}
          error={reasonError}
          disabled={busy}
          onChange={setReason}
        />
        {failure !== null && <Banner tone="danger" message={recoveryErrorMessage(failure)} />}
        <div className="flex justify-end gap-3">
          <Button
            label={recoveriesCopy.keep}
            variant="secondary"
            disabled={busy}
            onClick={onClose}
          />
          <Button type="submit" label={submitLabel} loadingLabel={submittingLabel} loading={busy} />
        </div>
      </form>
    </Modal>
  );
}

/**
 * Both whole addresses, with a reason (ADR-0043 § 6): dispatched with
 * `track: false` and held in this dialog's state alone, as
 * `RevealCustomerEmailDialog` holds one address.
 */
export function RevealEmailsDialog({
  recoveryId,
  onClose,
}: {
  recoveryId: string;
  onClose: () => void;
}) {
  const dispatch = useAppDispatch();
  const [emails, setEmails] = useState<AdminAccountRecoveryEmails | null>(null);

  if (emails !== null) {
    return (
      <Modal title={recoveriesCopy.revealTitle} onClose={onClose}>
        <dl className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <dt className="text-caption text-text-muted">{recoveriesCopy.oldEmail}</dt>
            <dd className="select-all break-all text-h2 text-text">{emails.oldEmail}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-caption text-text-muted">{recoveriesCopy.newEmail}</dt>
            <dd className="select-all break-all text-h2 text-text">{emails.newEmail}</dd>
          </div>
        </dl>
        <div className="flex justify-end">
          <Button label={recoveriesCopy.close} variant="secondary" onClick={onClose} />
        </div>
      </Modal>
    );
  }

  return (
    <ReasonDialog
      title={recoveriesCopy.revealTitle}
      body={recoveriesCopy.revealBody}
      hint={recoveriesCopy.revealHint}
      submitLabel={recoveriesCopy.reveal}
      submittingLabel={recoveriesCopy.revealing}
      onClose={onClose}
      onDone={() => undefined}
      onSubmit={async (reason) => {
        const result = await dispatch(
          recoveriesApi.endpoints.revealRecoveryEmails.initiate(
            { id: recoveryId, reason },
            { track: false },
          ),
        );
        if (result.data === undefined) {
          return describeFailure(result.error) ?? { status: 'network', code: undefined };
        }
        setEmails(result.data);
        return undefined;
      }}
    />
  );
}
