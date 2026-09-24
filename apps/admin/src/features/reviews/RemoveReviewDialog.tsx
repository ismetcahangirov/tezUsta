import type { AdminReview } from '@tezusta/types';
import { type FormEvent, useState } from 'react';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { useRemoveReviewMutation } from './api';
import { reviewsCopy } from './copy';

/** Removal with a mandatory reason (ADR-0042 § 7). Nothing is deleted; the review is marked. */
export function RemoveReviewDialog({
  review,
  onClose,
}: {
  review: AdminReview;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [remove, { isLoading, isError }] = useRemoveReviewMutation();
  const text = reviewsCopy.removal;

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
    const result = await remove({ id: review.id, reason: reason.trim() });
    if (result.error === undefined) onClose();
  }

  return (
    <Dialog title={text.title} onClose={onClose}>
      <form noValidate className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {isError && <Banner tone="danger" message={text.failed} />}
        <blockquote className="whitespace-pre-wrap break-words rounded-sm bg-surface-alt px-4 py-3 text-body text-text">
          {text.quote(
            reviewsCopy.table.stars(review.rating),
            review.comment ?? reviewsCopy.table.noComment,
          )}
        </blockquote>
        <ReasonField
          label={text.reason}
          hint={text.hint}
          value={reason}
          error={reasonError}
          disabled={isLoading}
          onChange={setReason}
        />
        <div className="flex justify-end gap-2">
          <Button label={text.cancel} variant="secondary" onClick={onClose} />
          <Button
            type="submit"
            label={text.confirm}
            loadingLabel={text.confirming}
            loading={isLoading}
          />
        </div>
      </form>
    </Dialog>
  );
}
