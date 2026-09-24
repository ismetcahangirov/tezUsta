import type { PartyRating } from '@tezusta/types';
import { View } from 'react-native';

import { StarFilledIcon, StarIcon, Text } from '../components';
import { presentPartyRating } from './format-rating';

export interface PartyRatingLineProps {
  /** Whose rating — "Ustanın reytinqi". */
  readonly label: string;
  readonly rating: PartyRating;
}

/**
 * The other side's rating on an accepted order (ADR-0042 § 6, issue #228):
 * a caption, a star and "4,7 · 12 rəy".
 *
 * **One small star, not five.** Five partly filled stars would need a half
 * star the design system does not have and ADR-0042 § 5 refuses for input; the
 * number carries the value and the star says what kind of number it is —
 * filled when there is a rating, an outline beside "no ratings yet".
 *
 * Read as one element, so a screen reader says the label and the line
 * together instead of three fragments.
 */
export function PartyRatingLine({ label, rating }: PartyRatingLineProps): React.JSX.Element {
  const line = presentPartyRating(rating);
  const rated = rating.ratingAverage !== null && rating.ratingCount > 0;

  return (
    <View accessible accessibilityLabel={`${label}: ${line}`} className="gap-1">
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <View className="flex-row items-center gap-2">
        {rated ? <StarFilledIcon size="sm" /> : <StarIcon size="sm" tone="text-muted" />}
        <Text variant={rated ? 'body-strong' : 'body'} tone={rated ? 'default' : 'muted'}>
          {line}
        </Text>
      </View>
    </View>
  );
}
