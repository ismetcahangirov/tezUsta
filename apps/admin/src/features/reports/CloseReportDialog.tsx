import type { ReportOutcome } from '@tezusta/types';
import { useState } from 'react';

import { describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { SelectField } from '../../components/SelectField';
import { useCloseReportMutation } from './api';
import { reportErrorMessage, reportsCopy } from './copy';

const OUTCOMES = Object.keys(reportsCopy.outcomes) as ReportOutcome[];

/**
 * Closes a report with an outcome and a reason (ADR-0053 § 4). Closing changes
 * nobody's account; a suspension outcome records one made on the reported
 * person's page, and the server refuses it when that page shows none.
 */
export function CloseReportDialog({
  reportId,
  onClose,
  onDone,
}: {
  reportId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [outcome, setOutcome] = useState<ReportOutcome>('no_action');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [closeReport, { isLoading, error, reset }] = useCloseReportMutation();
  const failure = describeFailure(error);

  const problem = reasonProblem(reason);
  const reasonError =
    touched && problem !== undefined
      ? problem === 'empty'
        ? reportsCopy.reasonEmpty
        : reportsCopy.reasonTooLong
      : undefined;

  async function submit() {
    setTouched(true);
    if (problem !== undefined) return;
    const result = await closeReport({ reportId, outcome, reason: reason.trim() });
    if (result.error === undefined) onDone();
  }

  return (
    <Modal title={reportsCopy.closeTitle} onClose={onClose} busy={isLoading}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="text-body text-text">{reportsCopy.closeBody}</p>
        <SelectField
          label={reportsCopy.outcomeLabel}
          value={outcome}
          options={OUTCOMES.map((option) => ({
            value: option,
            label: reportsCopy.outcomes[option],
          }))}
          onChange={(event) => {
            setOutcome(event.target.value as ReportOutcome);
            if (failure !== undefined) reset();
          }}
        />
        <ReasonField
          label={reportsCopy.reasonLabel}
          hint={reportsCopy.reasonHint}
          value={reason}
          error={reasonError}
          disabled={isLoading}
          onChange={(value) => {
            setReason(value);
            if (failure !== undefined) reset();
          }}
        />
        {failure !== undefined && (
          <Banner tone="danger" message={reportErrorMessage(failure.code)} />
        )}
        <div className="flex justify-end gap-3">
          <Button
            label={reportsCopy.cancel}
            variant="secondary"
            disabled={isLoading}
            onClick={onClose}
          />
          <Button
            type="submit"
            label={reportsCopy.submit}
            loadingLabel={reportsCopy.submitting}
            loading={isLoading}
          />
        </div>
      </form>
    </Modal>
  );
}
