import { skipToken } from '@reduxjs/toolkit/query';
import type { ReviewAuthorRole } from '@tezusta/types';

import { shouldPromptReview } from './review-availability';
import { ReviewPrompt } from './ReviewPrompt';
import { useOrderReviewsQuery } from './reviews-endpoints';

export interface OrderReviewPromptProps {
  /** The order to ask about, or `null` to ask about nothing and make no request. */
  readonly orderId: string | null;
  readonly viewer: ReviewAuthorRole;
  readonly onPress: (orderId: string) => void;
}

/**
 * The prompt card for one order, shown exactly while the reader may still
 * review it and has not (ADR-0042 § 1).
 *
 * **The server decides, from `GET /orders/:id/reviews`.** Nothing about the
 * window or the status is worked out here; `canReview` already says it. The
 * entry is shared with the review screen, so submitting there invalidates it
 * and the card is gone by the time the screen pops back.
 *
 * **Nothing while it loads or fails.** A prompt is an invitation, not
 * information: a skeleton or an error box where a "rate your master" card
 * might have been is noise on a screen whose subject is the order.
 */
export function OrderReviewPrompt({
  orderId,
  viewer,
  onPress,
}: OrderReviewPromptProps): React.JSX.Element | null {
  const reviews = useOrderReviewsQuery(orderId ?? skipToken);

  if (orderId === null || !shouldPromptReview(reviews.currentData)) {
    return null;
  }

  return (
    <ReviewPrompt
      viewer={viewer}
      onPress={() => {
        onPress(orderId);
      }}
    />
  );
}
