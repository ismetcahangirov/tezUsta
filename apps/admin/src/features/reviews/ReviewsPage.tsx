import type { AdminReview } from '@tezusta/types';
import { type FormEvent, useState } from 'react';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Table, TD_CLASS, TH_CLASS } from '../../components/Table';
import { TextField } from '../../components/TextField';
import { copy } from '../../copy';
import { formatDateTime } from '../../format';
import { PageFrame } from '../../shell/PageFrame';
import { isUuid, shortId } from '../../uuid';
import { type ReviewFilters, useReviewsInfiniteQuery } from './api';
import { reviewsCopy } from './copy';
import { RecalculateDialog } from './RecalculateDialog';
import { RemoveReviewDialog } from './RemoveReviewDialog';

type FilterKey = keyof ReviewFilters;
const FILTER_KEYS: readonly FilterKey[] = ['orderId', 'masterId', 'customerId'];
type Draft = Record<FilterKey, string>;
const EMPTY_DRAFT: Draft = { orderId: '', masterId: '', customerId: '' };

function toFilters(draft: Draft): ReviewFilters {
  return Object.fromEntries(
    FILTER_KEYS.flatMap((key) => (draft[key].trim() === '' ? [] : [[key, draft[key].trim()]])),
  );
}

/**
 * Review moderation (EPIC 11 API, #251): every review with the filters the
 * API supports, a page at a time, each removable with a reason. A comment is
 * someone's untrusted text and is rendered as text — React escapes it.
 */
export function ReviewsPage() {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [draftErrors, setDraftErrors] = useState<Partial<Record<FilterKey, string>>>({});
  const [filters, setFilters] = useState<ReviewFilters>({});
  const [removing, setRemoving] = useState<AdminReview | null>(null);
  const [recalculating, setRecalculating] = useState(false);
  const { data, error, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } =
    useReviewsInfiniteQuery(filters);

  function apply(next: Draft) {
    const errors = Object.fromEntries(
      FILTER_KEYS.flatMap((key) =>
        next[key].trim() === '' || isUuid(next[key]) ? [] : [[key, reviewsCopy.filters.invalidId]],
      ),
    );
    setDraft(next);
    setDraftErrors(errors);
    if (Object.keys(errors).length === 0) setFilters(toFilters(next));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    apply(draft);
  }

  const reviews = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <PageFrame title={copy.nav.reviews}>
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-3xl text-body text-text-muted">{reviewsCopy.intro}</p>
        <Button
          label={reviewsCopy.recalculate}
          variant="secondary"
          onClick={() => {
            setRecalculating(true);
          }}
        />
      </div>

      <form
        noValidate
        aria-label={reviewsCopy.filters.title}
        className="flex items-start gap-3 rounded-md border-hairline border-border bg-surface p-4"
        onSubmit={submit}
      >
        {FILTER_KEYS.map((key) => (
          <TextField
            key={key}
            label={reviewsCopy.filters[key]}
            value={draft[key]}
            error={draftErrors[key]}
            spellCheck={false}
            onChange={(event) => {
              setDraft({ ...draft, [key]: event.target.value });
            }}
          />
        ))}
        <div className="flex gap-2 pt-6">
          <Button type="submit" label={reviewsCopy.filters.apply} />
          <Button
            label={reviewsCopy.filters.clear}
            variant="ghost"
            onClick={() => {
              apply(EMPTY_DRAFT);
            }}
          />
        </div>
      </form>

      {data === undefined ? (
        isLoading || error === undefined ? (
          <p role="status" className="text-body text-text-muted">
            {reviewsCopy.loading}
          </p>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Banner tone="danger" message={reviewsCopy.loadFailed} />
            <Button label={reviewsCopy.retry} variant="secondary" onClick={() => void refetch()} />
          </div>
        )
      ) : reviews.length === 0 ? (
        <p className="text-body text-text-muted">{reviewsCopy.empty}</p>
      ) : (
        <>
          <ReviewTable
            reviews={reviews}
            onRemove={setRemoving}
            onFilter={(key, id) => {
              apply({ ...EMPTY_DRAFT, [key]: id });
            }}
          />
          {hasNextPage && (
            <Button
              label={reviewsCopy.loadMore}
              loadingLabel={reviewsCopy.loadingMore}
              loading={isFetchingNextPage}
              variant="secondary"
              className="self-start"
              onClick={() => void fetchNextPage()}
            />
          )}
        </>
      )}

      {removing !== null && (
        <RemoveReviewDialog
          review={removing}
          onClose={() => {
            setRemoving(null);
          }}
        />
      )}
      {recalculating && (
        <RecalculateDialog
          onClose={() => {
            setRecalculating(false);
          }}
        />
      )}
    </PageFrame>
  );
}

function ReviewTable({
  reviews,
  onRemove,
  onFilter,
}: {
  reviews: readonly AdminReview[];
  onRemove: (review: AdminReview) => void;
  onFilter: (key: FilterKey, id: string) => void;
}) {
  const text = reviewsCopy.table;
  return (
    <Table caption={text.caption}>
      <thead>
        <tr>
          <th scope="col" className={TH_CLASS}>
            {text.created}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.rating}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.author}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.comment}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.order}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.parties}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.status}
          </th>
          <th scope="col" className={TH_CLASS}>
            <span className="sr-only">{text.actions}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {reviews.map((review) => (
          <tr key={review.id} className={review.removedAt === null ? '' : 'text-text-muted'}>
            <td className={TD_CLASS}>{formatDateTime(review.createdAt)}</td>
            <td className={`${TD_CLASS} whitespace-nowrap font-bold`}>
              {text.stars(review.rating)}
            </td>
            <td className={TD_CLASS}>
              {review.authorRole === 'customer' ? text.customerAuthor : text.masterAuthor}
            </td>
            <td className={`${TD_CLASS} max-w-md whitespace-pre-wrap break-words`}>
              {review.comment ?? <span className="text-text-muted">{text.noComment}</span>}
            </td>
            <td className={TD_CLASS}>
              <IdButton
                id={review.orderId}
                label={text.filterByOrder(review.orderId)}
                onClick={() => {
                  onFilter('orderId', review.orderId);
                }}
              />
            </td>
            <td className={TD_CLASS}>
              <div className="flex flex-col items-start gap-1">
                <IdButton
                  id={review.masterId}
                  label={text.filterByMaster(review.masterId)}
                  onClick={() => {
                    onFilter('masterId', review.masterId);
                  }}
                />
                <IdButton
                  id={review.customerId}
                  label={text.filterByCustomer(review.customerId)}
                  onClick={() => {
                    onFilter('customerId', review.customerId);
                  }}
                />
              </div>
            </td>
            <td className={TD_CLASS}>
              {review.removedAt !== null ? (
                <div className="flex flex-col gap-1">
                  <span className="font-bold">{text.removed}</span>
                  {review.removalReason !== null && (
                    <span className="text-caption">
                      {text.removedBecause(review.removalReason)}
                    </span>
                  )}
                </div>
              ) : review.revealedAt === null ? (
                text.sealed
              ) : (
                text.visible
              )}
            </td>
            <td className={TD_CLASS}>
              {review.removedAt === null && (
                <Button
                  label={text.remove}
                  variant="secondary"
                  onClick={() => {
                    onRemove(review);
                  }}
                />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function IdButton({ id, label, onClick }: { id: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={id}
      aria-label={label}
      className="rounded-sm font-mono text-caption text-text underline outline-none focus-visible:ring-2 focus-visible:ring-focus"
      onClick={onClick}
    >
      {shortId(id)}
    </button>
  );
}
