import { useState } from 'react';

import { describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { useAppDispatch } from '../../hooks';
import { customersApi } from './api';
import { customerErrorMessage, customersCopy } from './copy';

export interface RevealCustomerPhoneDialogProps {
  customerId: string;
  name: string;
  onClose: () => void;
}

/**
 * Reveals a customer's full number with a reason (ADR-0043 § 6), the same way
 * the order screen reveals a party's: dispatched with `track: false`, held in
 * this dialog's state alone, and gone when it closes.
 */
export function RevealCustomerPhoneDialog({
  customerId,
  name,
  onClose,
}: RevealCustomerPhoneDialogProps) {
  const dispatch = useAppDispatch();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failureCode, setFailureCode] = useState<string | null | undefined>(undefined);
  const [phone, setPhone] = useState<string | null>(null);

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
    setBusy(true);
    setFailureCode(undefined);
    const result = await dispatch(
      customersApi.endpoints.revealCustomerPhone.initiate(
        { customerId, reason: reason.trim() },
        { track: false },
      ),
    );
    setBusy(false);
    if (result.data === undefined) {
      setFailureCode(describeFailure(result.error)?.code ?? null);
      return;
    }
    setPhone(result.data.phoneE164);
  }

  return (
    <Modal title={customersCopy.revealTitle(name)} onClose={onClose} busy={busy}>
      {phone === null ? (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="text-body text-text">{customersCopy.revealBody}</p>
          <ReasonField
            label={customersCopy.reasonLabel}
            hint={customersCopy.revealReasonHint}
            value={reason}
            error={reasonError}
            disabled={busy}
            onChange={setReason}
          />
          {failureCode !== undefined && (
            <Banner tone="danger" message={customerErrorMessage(failureCode ?? undefined)} />
          )}
          <div className="flex justify-end gap-3">
            <Button
              label={customersCopy.cancel}
              variant="secondary"
              disabled={busy}
              onClick={onClose}
            />
            <Button
              type="submit"
              label={customersCopy.reveal}
              loadingLabel={customersCopy.revealing}
              loading={busy}
            />
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-caption text-text-muted">{customersCopy.revealedLabel}</span>
            <output className="select-all text-h2 font-bold text-text">{phone}</output>
          </div>
          <div className="flex justify-end">
            <Button label={customersCopy.close} variant="secondary" onClick={onClose} />
          </div>
        </div>
      )}
    </Modal>
  );
}
