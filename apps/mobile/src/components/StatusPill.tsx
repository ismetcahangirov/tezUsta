import { Badge, type BadgeTone } from './Badge';

/**
 * The states TezUsta actually shows a user. Colour alone never carries the
 * meaning — the label does — which is why several of the states share a tone.
 * docs/design/design-system.md §"Status".
 */
export type StatusTone = 'active' | 'pending' | 'done' | 'cancelled' | 'unfilled';

const BADGE_TONE: Record<StatusTone, BadgeTone> = {
  active: 'accent',
  pending: 'neutral',
  done: 'accent',
  cancelled: 'danger',
  /**
   * **An order nobody could take** — `NO_MASTER_FOUND`, and nothing else
   * ([ADR-0029](../../../../docs/decisions/ADR-0029-customer-order-screen.md),
   * settling the open item `design-system.md` § 9 recorded).
   *
   * Neutral today, and named separately anyway. `cancelled` would say somebody
   * cancelled, which is precisely the conflation that status exists to prevent:
   * nobody did, the platform had no supply nearby. `pending` would say it is
   * still going, and it is terminal. Giving it its own name costs one line and
   * makes a future fifth badge tone a one-line change rather than a search
   * through every screen.
   */
  unfilled: 'neutral',
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
