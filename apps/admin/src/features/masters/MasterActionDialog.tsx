import { useState } from 'react';

import { describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { ACTION_NEEDS_REASON } from './actions';
import { type MasterAction, useMasterActionMutation } from './api';
import { mastersCopy } from './copy';

export interface MasterActionDialogProps {
  masterId: string;
  masterName: string;
  action: MasterAction;
  onClose: () => void;
  onDone: (action: MasterAction) => void;
}

function errorMessage(code: string | undefined): string {
  switch (code) {
    case 'CONFLICT':
    case 'NOT_FOUND':
    case 'FORBIDDEN':
    case 'VALIDATION_FAILED':
      return mastersCopy.errors[code];
    default:
      return mastersCopy.errors.unexpected;
  }
}

/**
 * Confirms one review decision. The three negative outcomes require a reason
 * the master will read; `verify` and `reinstate` send an empty body, because
 * the API refuses a reason there rather than dropping it.
 */
export function MasterActionDialog({
  masterId,
  masterName,
  action,
  onClose,
  onDone,
}: MasterActionDialogProps) {
  const needsReason = ACTION_NEEDS_REASON[action];
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [act, { isLoading, error, reset }] = useMasterActionMutation();
  const failure = describeFailure(error);

  const problem = needsReason ? reasonProblem(reason) : undefined;
  const reasonError =
    touched && problem !== undefined
      ? problem === 'empty'
        ? mastersCopy.reasonEmpty
        : mastersCopy.reasonTooLong
      : undefined;

  async function submit() {
    setTouched(true);
    if (problem !== undefined) return;
    const result = await act({
      masterId,
      action,
      ...(needsReason ? { reason: reason.trim() } : {}),
    });
    if (result.error === undefined) onDone(action);
  }

  return (
    <Modal title={mastersCopy.confirmTitle[action]} onClose={onClose} busy={isLoading}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="text-body text-text">{mastersCopy.confirmBody[action](masterName)}</p>
        {needsReason && (
          <ReasonField
            label={mastersCopy.reasonLabel}
            hint={mastersCopy.reasonHint}
            value={reason}
            error={reasonError}
            disabled={isLoading}
            onChange={(value) => {
              setReason(value);
              if (failure !== undefined) reset();
            }}
          />
        )}
        {failure !== undefined && <Banner tone="danger" message={errorMessage(failure.code)} />}
        <div className="flex justify-end gap-3">
          <Button
            label={mastersCopy.cancel}
            variant="secondary"
            disabled={isLoading}
            onClick={onClose}
          />
          <Button
            type="submit"
            label={mastersCopy.actionLabel[action]}
            loadingLabel={mastersCopy.submitting}
            loading={isLoading}
            variant={action === 'suspend' || action === 'reject' ? 'primary' : 'accent'}
          />
        </div>
      </form>
    </Modal>
  );
}
