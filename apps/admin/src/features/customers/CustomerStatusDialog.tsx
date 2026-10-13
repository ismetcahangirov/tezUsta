import type { AdminCustomerSuspension } from '@tezusta/types';
import { useState } from 'react';

import { describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { useReinstateCustomerMutation, useSuspendCustomerMutation } from './api';
import { customerErrorMessage, customersCopy } from './copy';

export type CustomerStatusAction = 'suspend' | 'reinstate';

export interface CustomerStatusDialogProps {
  customerId: string;
  customerName: string;
  action: CustomerStatusAction;
  /** The master profile on the same account, which a suspension stops too. */
  masterName: string | null;
  onClose: () => void;
  /** A suspension answers with what it did to the orders; a reinstatement with nothing more. */
  onDone: (
    result: { action: 'suspend'; suspension: AdminCustomerSuspension } | { action: 'reinstate' },
  ) => void;
}

/**
 * Confirms a suspension or a reinstatement, each with a mandatory reason
 * (#328). The suspension says what happens to the orders, and warns before
 * confirming when the account also holds a master profile — a suspension
 * belongs to the account, not to one of its roles.
 */
export function CustomerStatusDialog({
  customerId,
  customerName,
  action,
  masterName,
  onClose,
  onDone,
}: CustomerStatusDialogProps) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [suspend, suspendState] = useSuspendCustomerMutation();
  const [reinstate, reinstateState] = useReinstateCustomerMutation();
  const state = action === 'suspend' ? suspendState : reinstateState;
  const failure = describeFailure(state.error);

  const problem = reasonProblem(reason);
  const reasonError =
    touched && problem !== undefined
      ? problem === 'empty'
        ? customersCopy.reasonEmpty
        : customersCopy.reasonTooLong
      : undefined;

  async function submit() {
    setTouched(true);
    if (problem !== undefined) return;
    const arg = { customerId, reason: reason.trim() };
    if (action === 'suspend') {
      const result = await suspend(arg);
      if (result.data !== undefined) onDone({ action, suspension: result.data });
    } else {
      const result = await reinstate(arg);
      if (result.error === undefined) onDone({ action });
    }
  }

  return (
    <Modal title={customersCopy.confirmTitle[action]} onClose={onClose} busy={state.isLoading}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="text-body text-text">{customersCopy.confirmBody[action](customerName)}</p>
        {action === 'suspend' && masterName !== null && (
          <Banner tone="danger" message={customersCopy.alsoMasterWarning(masterName)} />
        )}
        <ReasonField
          label={customersCopy.reasonLabel}
          hint={customersCopy.reasonHint}
          value={reason}
          error={reasonError}
          disabled={state.isLoading}
          onChange={(value) => {
            setReason(value);
            if (failure !== undefined) state.reset();
          }}
        />
        {failure !== undefined && (
          <Banner tone="danger" message={customerErrorMessage(failure.code)} />
        )}
        <div className="flex justify-end gap-3">
          <Button
            label={customersCopy.cancel}
            variant="secondary"
            disabled={state.isLoading}
            onClick={onClose}
          />
          <Button
            type="submit"
            label={customersCopy.confirm[action]}
            loadingLabel={customersCopy.submitting}
            loading={state.isLoading}
            variant={action === 'suspend' ? 'primary' : 'accent'}
          />
        </div>
      </form>
    </Modal>
  );
}
