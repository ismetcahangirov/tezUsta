import type { Review, ReviewAuthorRole } from '@tezusta/types';
import { FlatList, View } from 'react-native';

import { Banner, Button, Card, EmptyState, Skeleton, StarRating, Text } from '../components';
import { formatOrderDate } from '../orders/format-order-date';
import { REVIEWS_COPY as copy } from './reviews-copy';
import { useReceivedReviewsInfiniteQuery } from './reviews-endpoints';

export interface ReceivedReviewsProps {
  /** The role on screen — whose reviews these are. Never both at once. */
  readonly role: ReviewAuthorRole;
  readonly onBack: () => void;
}

/**
 * "Reviews about me" (issue #228, ADR-0042 § 6): what the other side wrote
 * about the reader in the role they are using, newest first, a page at a time.
 *
 * **Revealed reviews only.** The server already returns nothing else; the
 * filter below is a second line, so a sealed review could never be shown to
 * the person it is about even if the server one day sent one by mistake — the
 * blindness ADR-0042 § 3 rests on is not something a list may get wrong.
 *
 * **"Load more", not endless scrolling** — the order list's pattern
 * (`Orders.tsx`): a page is requested because the reader asked for it, which
 * on metered mobile data is the honest trade.
 *
 * Comments are somebody else's words, rendered as characters by `Text` and
 * nothing more (ADR-0042 § 5).
 */
export function ReceivedReviews({ role, onBack }: ReceivedReviewsProps): React.JSX.Element {
  const reviews = useReceivedReviewsInfiniteQuery(role);
  const loaded = reviews.currentData?.pages
    .flatMap((page) => page.items)
    .filter((review) => review.revealedAt !== null && review.removedAt === null);

  if (loaded === undefined) {
    return (
      <ReceivedFrame onBack={onBack}>
        {reviews.error === undefined ? (
          <View accessible accessibilityLabel={copy.received.loading} className="gap-4">
            <Skeleton className="h-control-lg w-full" />
            <Skeleton className="h-control-lg w-full" />
          </View>
        ) : (
          <EmptyState
            title={copy.received.errorTitle}
            description={copy.received.errorDescription}
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
      </ReceivedFrame>
    );
  }

  if (loaded.length === 0 && !reviews.hasNextPage) {
    return (
      <ReceivedFrame onBack={onBack}>
        <EmptyState
          title={copy.received.emptyTitle}
          description={copy.received.emptyDescription[role]}
        />
      </ReceivedFrame>
    );
  }

  return (
    <ReceivedFrame onBack={onBack}>
      <FlatList
        data={loaded}
        keyExtractor={(review) => review.id}
        // No `className` on the list: `FlatList` is not one of the components
        // NativeWind maps one onto (see `OrderList.tsx`), so spacing lives on
        // the rows and the footer.
        renderItem={({ item }) => (
          <View className="pb-3">
            <ReceivedReviewRow review={item} role={role} />
          </View>
        )}
        ListFooterComponent={
          <View className="gap-3 pb-10">
            {reviews.isError && !reviews.isFetching && (
              <Banner tone="danger" message={copy.received.moreFailed} />
            )}
            {reviews.hasNextPage && (
              <Button
                label={
                  reviews.isFetchingNextPage ? copy.received.loadingMore : copy.received.loadMore
                }
                variant="secondary"
                loading={reviews.isFetchingNextPage}
                onPress={() => {
                  void reviews.fetchNextPage();
                }}
              />
            )}
          </View>
        }
      />
    </ReceivedFrame>
  );
}

interface ReceivedReviewRowProps {
  readonly review: Review;
  readonly role: ReviewAuthorRole;
}

function ReceivedReviewRow({ review, role }: ReceivedReviewRowProps): React.JSX.Element {
  return (
    <Card className="gap-2">
      <View className="flex-row items-center justify-between gap-3">
        <StarRating
          value={review.rating}
          label={copy.ratingReading(review.rating)}
          starLabel={copy.star}
          size="md"
        />
        <Text variant="footnote" tone="muted">
          {formatOrderDate(review.revealedAt ?? review.createdAt)}
        </Text>
      </View>
      <Text variant="caption" tone="muted">
        {copy.received.from[role]}
      </Text>
      <Text variant="body" tone={review.comment === null ? 'muted' : 'default'}>
        {review.comment ?? copy.noComment}
      </Text>
    </Card>
  );
}

interface ReceivedFrameProps {
  readonly onBack: () => void;
  readonly children: React.ReactNode;
}

function ReceivedFrame({ onBack, children }: ReceivedFrameProps): React.JSX.Element {
  return (
    <View className="flex-1 gap-4 p-6">
      <View className="flex-row items-center justify-between">
        <Text variant="h1">{copy.received.title}</Text>
        <Button label={copy.back} variant="ghost" size="sm" onPress={onBack} />
      </View>
      {children}
    </View>
  );
}
