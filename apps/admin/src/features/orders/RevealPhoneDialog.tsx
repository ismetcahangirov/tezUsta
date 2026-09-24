import { useState } from 'react';

import { describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { useAppDispatch } from '../../hooks';
import { type OrderParty, ordersApi } from './api';
import { ordersCopy } from './copy';
import { orderErrorMessage } from './rules';

export interface RevealPhoneDialogProps {
  orderId: string;
  party: OrderParty;
  name: string;
  onClose: () => void;
}

/**
 * Reveals one party's full number with a reason (ADR-0043 § 6).
 *
 * The number is held in this dialog's own state and nowhere else: the request
 * is dispatched with `track: false`, so the store never sees it, and closing
 * the dialog unmounts the only copy. Opening it again is a new, audited reveal.
 */
export function RevealPhoneDialog({ orderId, party, name, onClose }: RevealPhoneDialogProps) {
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
        ? ordersCopy.reasonEmpty
        : ordersCopy.reasonTooLong
      : undefined;

  async function submit() {
    setTouched(true);
    if (problem !== undefined) return;
    setBusy(true);
    setFailureCode(undefined);
    const result = await dispatch(
      ordersApi.endpoints.revealPhone.initiate(
        { orderId, party, reason: reason.trim() },
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
    <Modal title={ordersCopy.revealTitle(name)} onClose={onClose} busy={busy}>
      {phone === null ? (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="text-body text-text">{ordersCopy.revealBody}</p>
          <ReasonField
            label={ordersCopy.reasonLabel}
            hint={ordersCopy.revealReasonHint}
            value={reason}
            error={reasonError}
            disabled={busy}
            onChange={setReason}
          />
          {failureCode !== undefined && (
            <Banner tone="danger" message={orderErrorMessage(failureCode ?? undefined)} />
          )}
          <div className="flex justify-end gap-3">
            <Button
              label={ordersCopy.cancel}
              variant="secondary"
              disabled={busy}
              onClick={onClose}
            />
            <Button
              type="submit"
              label={ordersCopy.reveal}
              loadingLabel={ordersCopy.revealing}
              loading={busy}
            />
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-caption text-text-muted">{ordersCopy.revealedLabel}</span>
            <output className="select-all text-h2 font-bold text-text">{phone}</output>
          </div>
          <div className="flex justify-end">
            <Button label={ordersCopy.close} variant="secondary" onClick={onClose} />
          </div>
        </div>
      )}
    </Modal>
  );
}
