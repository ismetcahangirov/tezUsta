import { Badge, type BadgeTone } from './Badge';

/**
 * The states TezUsta actually shows a user. Colour alone never carries the
 * meaning — the label does — which is why three of the four states share a
 * tone. docs/design/design-system.md §"Status".
 */
export type StatusTone = 'active' | 'pending' | 'done' | 'cancelled';

const BADGE_TONE: Record<StatusTone, BadgeTone> = {
  active: 'accent',
  pending: 'neutral',
  done: 'accent',
  cancelled: 'danger',
};

export interface StatusPillProps {
  status: StatusTone;
  /** The human-readable state. Always required: the colour is not the message. */
  label: string;
  className?: string;
}

export function StatusPill({ status, label, className }: StatusPillProps): React.JSX.Element {
  return <Badge label={label} tone={BADGE_TONE[status]} className={className} />;
}
