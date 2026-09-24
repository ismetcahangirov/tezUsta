import type { Review, ReviewAuthorRole } from '@tezusta/types';
import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, View } from 'react-native';

import {
  Banner,
  Button,
  Card,
  EmptyState,
  Skeleton,
  StarRating,
  Text,
  TextField,
} from '../components';
import { reviewScreenMode } from './review-availability';
import { reviewFailureOf, type ReviewFailure } from './review-errors';
import { REVIEWS_COPY as copy } from './reviews-copy';
import {
  useEditReviewMutation,
  useOrderReviewsQuery,
  useSubmitReviewMutation,
} from './reviews-endpoints';

/**
 * The longest comment the API accepts (`MAX_REVIEW_COMMENT_LENGTH` in
 * `reviews.schema.ts`, ADR-0042 § 5). Restated rather than imported —
 * `apps/mobile` may not import `apps/api` — and enforced by the field, so the
 * server's 422 is never the first the user hears of it.
 */
export const MAX_REVIEW_COMMENT_LENGTH = 500;

/**
 * `KeyboardAvoidingView` takes no `className` (see `Conversation.tsx`), so its
 * one layout rule is a style — the absence of a size, not a design value.
 */
const FILL = { flex: 1 } as const;

/**
 * Characters as the server counts them: code points, which is what Postgres's
 * `char_length` measures. An emoji is one here, as it is in the CHECK.
 */
function characterCount(text: string): number {
  return Array.from(text).length;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error as { status?: unknown };
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

export interface OrderReviewProps {
  readonly orderId: string;
  readonly onBack: () => void;
  /** After a submit or an edit the server accepted — the route pops back to the order. */
  readonly onDone: () => void;
}

/**
 * The review screen, for either side of an order (issue #227,
 * [ADR-0042](docs/decisions/ADR-0042-review-policy.md) § 8).
 *
 * **Told the order id and nothing else**, like the order and conversation
 * screens: which side the reader is on, whether they may write, and whether
 * their review is still sealed all come from `GET /orders/:id/reviews`, so a
 * reminder tapped a day late opens the screen in whatever state is true now.
 *
 * **Four modes, one per answer** (`reviewScreenMode`): write, edit while
 * sealed, read-only once revealed or removed, and nothing to write. Input is
 * switched on only by the server's `canReview`/`canEdit`.
 *
 * **A pushed screen with the keyboard avoided, not a sheet** (ADR-0042 § 8):
 * the comment field is a keyboard surface, and the stars, the field and the
 * button scroll together above it on a small Android screen.
 */
export function OrderReview({ orderId, onBack, onDone }: OrderReviewProps): React.JSX.Element {
  const reviews = useOrderReviewsQuery(orderId);
  const [failure, setFailure] = useState<ReviewFailure | null>(null);
  const current = reviews.currentData;

  if (current === undefined) {
    const status = statusOf(reviews.error);
    return (
      <ReviewFrame onBack={onBack}>
        {reviews.error === undefined ? (
          <View accessible accessibilityLabel={copy.loading} className="gap-4">
            <Skeleton className="h-control-lg w-full" />
            <Skeleton className="h-control-lg w-full" />
          </View>
        ) : status === 404 || status === 403 ? (
          <EmptyState title={copy.notFoundTitle} description={copy.notFoundDescription} />
        ) : (
          <EmptyState
            title={copy.errorTitle}
            description={copy.errorDescription}
            action={
              <Button
                label={copy.retry}
                loading={reviews.isFetching}
                onPress={() => {
                  void reviews.refetch();
                }}
              />
            }
          />
        )}
      </ReviewFrame>
    );
  }

  const mode = reviewScreenMode(current);

  return (
    <KeyboardAvoidingView behavior="padding" style={FILL}>
      <ReviewFrame onBack={onBack}>
        <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
          <View className="gap-6 pb-10">
            {failure !== null && <Banner tone="danger" message={copy.failure[failure]} />}

            {mode.kind === 'unavailable' ? (
              <EmptyState
                title={mode.why === 'not-yet' ? copy.notYetTitle : copy.closedTitle}
                description={
                  mode.why === 'not-yet' ? copy.notYetDescription : copy.closedDescription
                }
              />
            ) : mode.kind === 'read' ? (
              <ReadOnlyReview
                heading={copy.mineHeading}
                review={mode.review}
                notice={
                  mode.why === 'removed'
                    ? copy.removedNotice
                    : mode.why === 'revealed'
                      ? copy.revealedNotice
                      : copy.closedSealedNotice
                }
              />
            ) : (
              <ReviewForm
                // A new form when the review it edits changes underneath it —
                // a 409 re-read, say — so the fields start from the server's
                // copy rather than from what was typed against an older one.
                key={mode.kind === 'edit' ? `${mode.review.id}:${mode.review.updatedAt}` : 'new'}
                orderId={orderId}
                role={current.role}
                existing={mode.kind === 'edit' ? mode.review : null}
                onFailure={setFailure}
                onDone={onDone}
              />
            )}

            {current.theirs !== null && (
              <ReadOnlyReview heading={copy.theirsHeading[current.role]} review={current.theirs} />
            )}
          </View>
        </ScrollView>
      </ReviewFrame>
    </KeyboardAvoidingView>
  );
}

interface ReviewFormProps {
  readonly orderId: string;
  readonly role: ReviewAuthorRole;
  /** The sealed review being edited, or `null` for a first review. */
  readonly existing: Review | null;
  readonly onFailure: (failure: ReviewFailure | null) => void;
  readonly onDone: () => void;
}

/**
 * Five stars, a comment, one button.
 *
 * **The rating is required and the comment is not** (ADR-0042 § 5). A press
 * with no stars says so under them rather than sending a request the server
 * would refuse with a 422 — client validation as UX, the server still the
 * control.
 */
function ReviewForm({
  orderId,
  role,
  existing,
  onFailure,
  onDone,
}: ReviewFormProps): React.JSX.Element {
  const [rating, setRating] = useState<number | null>(existing?.rating ?? null);
  const [comment, setComment] = useState(existing?.comment ?? '');
  const [touched, setTouched] = useState(false);
  const [submit, submitResult] = useSubmitReviewMutation();
  const [edit, editResult] = useEditReviewMutation();
  const busy = submitResult.isLoading || editResult.isLoading;
  const count = characterCount(comment);

  return (
    <View className="gap-6">
      {existing !== null && <Banner message={copy.sealedNotice} />}

      <View className="gap-2">
        <Text variant="h2">{copy.question[role]}</Text>
        <StarRating
          value={rating}
          label={copy.ratingLabel}
          starLabel={copy.star}
          disabled={busy}
          onChange={(next) => {
            setRating(next);
          }}
        />
        {touched && rating === null && (
          <Text variant="footnote" tone="danger">
            {copy.ratingRequired}
          </Text>
        )}
      </View>

      <View className="gap-1">
        <TextField
          label={copy.commentLabel}
          placeholder={copy.commentPlaceholder}
          value={comment}
          onChangeText={setComment}
          multiline
          maxLength={MAX_REVIEW_COMMENT_LENGTH}
          editable={!busy}
        />
        <Text
          variant="footnote"
          tone="muted"
          className="self-end"
          accessibilityLabel={copy.commentCountLabel(count, MAX_REVIEW_COMMENT_LENGTH)}
        >
          {copy.commentCount(count, MAX_REVIEW_COMMENT_LENGTH)}
        </Text>
      </View>

      <Button
        label={existing === null ? copy.submit : copy.save}
        variant="accent"
        size="lg"
        fullWidth
        loading={busy}
        onPress={() => {
          setTouched(true);
          if (rating === null) {
            return;
          }
          onFailure(null);
          const trimmed = comment.trim();
          const body = { orderId, rating, comment: trimmed === '' ? null : trimmed };
          const write = existing === null ? submit(body) : edit(body);
          void write
            .unwrap()
            .then(() => {
              onDone();
            })
            .catch((error: unknown) => {
              onFailure(reviewFailureOf(error));
            });
        }}
      />
    </View>
  );
}

interface ReadOnlyReviewProps {
  readonly heading: string;
  readonly review: Review;
  readonly notice?: string | undefined;
}

/**
 * A review nobody may change any more — the reader's own once frozen, or the
 * other side's once revealed.
 *
 * The comment is somebody's own words, untrusted (ADR-0042 § 5): rendered by
 * `Text` as characters and nothing else.
 */
function ReadOnlyReview({ heading, review, notice }: ReadOnlyReviewProps): React.JSX.Element {
  return (
    <View className="gap-3">
      {notice !== undefined && <Banner message={notice} />}
      <Card className="gap-3">
        <Text variant="caption" tone="muted">
          {heading}
        </Text>
        <StarRating
          value={review.rating}
          label={copy.ratingReading(review.rating)}
          starLabel={copy.star}
        />
        <Text variant="body" tone={review.comment === null ? 'muted' : 'default'}>
          {review.comment ?? copy.noComment}
        </Text>
      </Card>
    </View>
  );
}

interface ReviewFrameProps {
  readonly onBack: () => void;
  readonly children: React.ReactNode;
}

/** The title row every state shares, so back is reachable from all of them. */
function ReviewFrame({ onBack, children }: ReviewFrameProps): React.JSX.Element {
  return (
    <View className="flex-1 gap-4 p-6">
      <View className="flex-row items-center justify-between">
        <Text variant="h1">{copy.title}</Text>
        <Button label={copy.back} variant="ghost" size="sm" onPress={onBack} />
      </View>
      {children}
    </View>
  );
}
