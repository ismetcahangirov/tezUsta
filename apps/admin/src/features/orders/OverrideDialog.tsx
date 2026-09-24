import type { AdminOrderTransitionOption, AdminPermission, OrderStatus } from '@tezusta/types';
import { useId, useState } from 'react';

import { describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { useTransitionOrderMutation } from './api';
import { ordersCopy } from './copy';
import { orderErrorMessage, permissionForTarget } from './rules';

export interface OverrideDialogProps {
  orderId: string;
  /** Exactly `detail.transitions` — the server's edges, never a client copy. */
  transitions: readonly AdminOrderTransitionOption[];
  permissions: readonly AdminPermission[];
  onClose: () => void;
  onDone: (to: OrderStatus) => void;
}

/** Why an option cannot be chosen, or undefined when it can. */
function blockedBecause(
  option: AdminOrderTransitionOption,
  permissions: readonly AdminPermission[],
): string | undefined {
  if (!option.available) return ordersCopy.refundUnavailable;
  if (!permissions.includes(permissionForTarget(option.to))) return ordersCopy.noPermissionFor;
  return undefined;
}

/**
 * An admin transition (ADR-0015, ADR-0043 § 1 and § 5). It lists exactly the
 * edges the server offered: an edge the server marks unavailable (`REFUNDED`
 * until EPIC 12) and one the admin's role may not drive are both shown,
 * disabled, with the reason — so nobody wonders where an option went. A
 * reason is required on every move.
 */
export function OverrideDialog({
  orderId,
  transitions,
  permissions,
  onClose,
  onDone,
}: OverrideDialogProps) {
  const [target, setTarget] = useState<OrderStatus | null>(null);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [transition, { isLoading, error, reset }] = useTransitionOrderMutation();
  const failure = describeFailure(error);
  const groupName = useId();

  const problem = reasonProblem(reason);
  const reasonError =
    touched && problem !== undefined
      ? problem === 'empty'
        ? ordersCopy.reasonEmpty
        : ordersCopy.reasonTooLong
      : undefined;
  const targetError = touched && target === null ? ordersCopy.overrideChoose : undefined;

  async function submit() {
    setTouched(true);
    if (target === null || problem !== undefined) return;
    const result = await transition({ orderId, to: target, reason: reason.trim() });
    if (result.error === undefined) onDone(target);
  }

  return (
    <Modal title={ordersCopy.overrideTitle} onClose={onClose} busy={isLoading}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="text-body text-text">{ordersCopy.overrideBody}</p>
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-2 text-caption text-text-muted">{ordersCopy.overrideTarget}</legend>
          {transitions.map((option) => {
            const blocked = blockedBecause(option, permissions);
            const noteId = `${groupName}-${option.to}-note`;
            const labelId = `${groupName}-${option.to}-label`;
            return (
              <label
                key={option.to}
                className={`flex items-start gap-3 rounded-sm border-hairline px-4 py-3 ${
                  target === option.to ? 'border-focus' : 'border-border'
                } ${blocked === undefined ? 'cursor-pointer' : 'opacity-40'}`}
              >
                <input
                  type="radio"
                  name={groupName}
                  value={option.to}
                  checked={target === option.to}
                  disabled={blocked !== undefined || isLoading}
                  aria-labelledby={labelId}
                  aria-describedby={blocked === undefined ? undefined : noteId}
                  onChange={() => {
                    setTarget(option.to);
                    if (failure !== undefined) reset();
                  }}
                  className="mt-1 accent-accent"
                />
                <span className="flex flex-col">
                  <span id={labelId} className="text-body-strong font-bold text-text">
                    {ordersCopy.status[option.to]}
                  </span>
                  {blocked !== undefined && (
                    <span id={noteId} className="text-caption text-text-muted">
                      {blocked}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
          {targetError !== undefined && <p className="text-footnote text-danger">{targetError}</p>}
        </fieldset>
        <ReasonField
          label={ordersCopy.reasonLabel}
          hint={ordersCopy.overrideReasonHint}
          value={reason}
          error={reasonError}
          disabled={isLoading}
          onChange={(value) => {
            setReason(value);
            if (failure !== undefined) reset();
          }}
        />
        {failure !== undefined && (
          <Banner tone="danger" message={orderErrorMessage(failure.code)} />
        )}
        <div className="flex justify-end gap-3">
          <Button
            label={ordersCopy.cancel}
            variant="secondary"
            disabled={isLoading}
            onClick={onClose}
          />
          <Button
            type="submit"
            label={ordersCopy.overrideSubmit}
            loadingLabel={ordersCopy.submitting}
            loading={isLoading}
          />
        </div>
      </form>
    </Modal>
  );
}
