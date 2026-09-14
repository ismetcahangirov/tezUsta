import { View } from 'react-native';

import { cn } from '../lib/cn';

export interface ProgressBarProps {
  value: number;
  max?: number;
  /** Describes what is progressing, for assistive technology. */
  accessibilityLabel: string;
  className?: string;
}

/**
 * Square-ended by design. Every other surface in the system is rounded, so the
 * sharp progress bar is the one place the eye is told "this is a measurement".
 */
export function ProgressBar({
  value,
  max = 1,
  accessibilityLabel,
  className,
}: ProgressBarProps): React.JSX.Element {
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.min(Math.max(value / safeMax, 0), 1);

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: safeMax, now: Math.min(Math.max(value, 0), safeMax) }}
      className={cn('h-progress-height w-full overflow-hidden rounded-none bg-track', className)}
    >
      {/* A percentage is data, not a design value — it cannot come from a token. */}
      <View className="h-full bg-accent" style={{ width: `${ratio * 100}%` }} />
    </View>
  );
}
