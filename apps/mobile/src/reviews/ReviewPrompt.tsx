import type { ReviewAuthorRole } from '@tezusta/types';
import { View } from 'react-native';

import { Card, ChevronRightIcon, ListRow, StarIcon } from '../components';
import { REVIEWS_COPY as copy } from './reviews-copy';

export interface ReviewPromptProps {
  /** Whose screen this is — the subtitle asks about the *other* side. */
  readonly viewer: ReviewAuthorRole;
  readonly onPress: () => void;
}

/**
 * The ask (ADR-0042 § 1): a card that opens the review screen.
 *
 * **The conversation entry's shape** — a `ListRow` in a `Card` with a trailing
 * chevron (ADR-0037) — because it sits in the same column of the same screens
 * and does the same thing: opens a pushed screen about this order. An outlined
 * star beside the chevron says what the screen is for without a second line of
 * words; it is the input's own "off" glyph, so the card and the screen it opens
 * read as one thing.
 *
 * Presentational: whether it is shown at all is the caller's decision, from
 * the server's `canReview` (`OrderReviewPrompt`).
 */
export function ReviewPrompt({ viewer, onPress }: ReviewPromptProps): React.JSX.Element {
  return (
    <Card className="py-0">
      <ListRow
        title={copy.prompt.title}
        subtitle={copy.prompt.subtitle[viewer]}
        onPress={onPress}
        trailing={
          <View className="flex-row items-center gap-2">
            <StarIcon tone="text-muted" />
            <ChevronRightIcon tone="text-muted" />
          </View>
        }
      />
    </Card>
  );
}
