import type { CallPartyKind } from '@tezusta/types';
import { useRouter } from 'expo-router';

import { IconButton, PhoneIcon } from '../components';
import { CALL_COPY as copy } from './call-copy';
import { CALLING_ENABLED } from './calling-enabled';

/** The outgoing call route, presented over whatever is on screen (ADR-0040 § 1). */
export const OUTGOING_CALL_ROUTE = '/call/outgoing/[orderId]';

export interface CallEntryProps {
  readonly orderId: string;
  /** This phone's side of the order — the label names the *other* party. */
  readonly viewer: CallPartyKind;
  /**
   * Whether the order is one its parties may call about (`canCallAbout`, or
   * the conversation's own `writable`). Not the check — the server refuses an
   * invite on any other order — but the reason the control disappears once
   * the order is over.
   */
  readonly available: boolean;
}

/**
 * The phone control on the order screen's status card, the master's job and
 * the conversation header, for both roles
 * ([ADR-0040](../../../../docs/decisions/ADR-0040-call-screens.md) § 6).
 *
 * **Absent, not disabled**, whenever a call cannot be placed: while the order
 * is not in a callable status, and — for now — always, because calling ships
 * dark until the room bridge lands (`CALLING_ENABLED`, ADR-0039 § 3). A
 * disabled phone button would be a promise with no date on it.
 *
 * It opens the outgoing call as a root modal rather than calling back, because
 * the destination is the same from every place it appears.
 */
export function CallEntry({
  orderId,
  viewer,
  available,
}: CallEntryProps): React.JSX.Element | null {
  const router = useRouter();

  if (!CALLING_ENABLED || !available) {
    return null;
  }

  return (
    <IconButton
      accessibilityLabel={copy.entry[viewer]}
      icon={<PhoneIcon tone="on-inverse" />}
      onPress={() => {
        router.push({ pathname: OUTGOING_CALL_ROUTE, params: { orderId } });
      }}
    />
  );
}
