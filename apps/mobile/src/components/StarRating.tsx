import { Pressable, View } from 'react-native';

import { cn } from '../lib/cn';
import { StarFilledIcon, StarIcon, type IconSize } from './icons';

/** Whole stars only (ADR-0042 § 5): nobody can tell a 3.5 from a 4 about a plumber. */
export const STAR_RATING_MAX = 5;

const STARS = [1, 2, 3, 4, 5] as const;

export interface StarRatingProps {
  /** 1–5, or `null` for "not chosen yet" — which draws five outlines, never a zero. */
  value: number | null;
  /**
   * Makes the row an input: five buttons, each choosing its own number. Absent,
   * the row is a read-only reading of `value` and announces itself once, as
   * `label`.
   */
  onChange?: (value: number) => void;
  /**
   * What the whole row is called — for the input, the group's name; read-only,
   * the entire reading ("Qiymət: 5-dən 4"), because five separate stars are
   * five things to swipe past to learn one number.
   */
  label: string;
  /** What a screen reader calls one star — "4 ulduz". Copy stays with the caller. */
  starLabel: (star: number) => string;
  disabled?: boolean;
  size?: IconSize;
  className?: string;
}

/**
 * Five stars: the review input and its read-only reading (ADR-0042 § 8).
 *
 * **Each star is its own button**, with its own label and a selected state, so
 * a screen reader can pick a rating in one tap rather than learning a custom
 * slider gesture. A star is selected when it is filled — every star up to the
 * chosen one — which is exactly what a sighted user sees; the label says which
 * number the star *chooses*, so "4 ulduz, selected" is never ambiguous.
 *
 * **Off is an outline, on is filled with `accent` and keeps its outline**
 * (`StarFilledIcon`). The shape and the fill both change, so the state survives
 * lime being nearly invisible on white — and the selected state says it aloud.
 *
 * Every star sits in a `touch-target` square: five 24-point glyphs in a row are
 * otherwise a row of mis-taps on a mid-range phone.
 */
export function StarRating({
  value,
  onChange,
  label,
  starLabel,
  disabled = false,
  size = 'lg',
  className,
}: StarRatingProps): React.JSX.Element {
  const chosen = value ?? 0;

  if (onChange === undefined) {
    return (
      <View
        accessible
        accessibilityLabel={label}
        className={cn('flex-row items-center', className)}
      >
        {STARS.map((star) =>
          star <= chosen ? (
            <StarFilledIcon key={star} size={size} />
          ) : (
            <StarIcon key={star} size={size} tone="text-muted" />
          ),
        )}
      </View>
    );
  }

  return (
    <View accessibilityLabel={label} className={cn('flex-row items-center', className)}>
      {STARS.map((star) => {
        const on = star <= chosen;
        return (
          <Pressable
            key={star}
            accessibilityRole="button"
            accessibilityLabel={starLabel(star)}
            accessibilityState={{ selected: on, disabled }}
            disabled={disabled}
            onPress={() => {
              onChange(star);
            }}
            className={cn(
              'h-touch-target w-touch-target items-center justify-center',
              disabled ? 'opacity-40' : 'active:opacity-80',
            )}
          >
            {on ? <StarFilledIcon size={size} /> : <StarIcon size={size} tone="text-muted" />}
          </Pressable>
        );
      })}
    </View>
  );
}
