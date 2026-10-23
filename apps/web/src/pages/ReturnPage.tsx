import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { useMySubscriptionQuery } from '../api/web-api';
import { Banner } from '../components/Banner';
import { clearSnapshot, hasChanged, readSnapshot } from '../checkout-handoff';
import { copy } from '../copy';
import { Card, PageFrame } from './PageFrame';

export interface ReturnTiming {
  /** How often the subscription is re-read while confirming. */
  readonly pollMs: number;
  /** When the page stops asking and says the payment will appear later. */
  readonly waitMs: number;
}

export const DEFAULT_RETURN_TIMING: ReturnTiming = { pollMs: 3_000, waitMs: 60_000 };

/**
 * Where the provider sends the browser back (`BILLING_RETURN_URL`, ADR-0061
 * § 6). Coming back proves nothing: the page re-reads the subscription until
 * it differs from what it was before checkout, and stops after a bounded
 * wait. Only the provider's webhook ever extends a period (ADR-0057).
 */
export function ReturnPage({ timing }: { timing: ReturnTiming }) {
  const [before] = useState(readSnapshot);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setTimedOut(true), timing.waitMs);
    return () => window.clearTimeout(timer);
  }, [timing.waitMs]);

  // Bounded polling (CLAUDE.md § 12): only while there is a "before" to
  // compare with, nothing has changed yet, and the wait has not run out.
  const [settled, setSettled] = useState(before === undefined);
  const probe = useMySubscriptionQuery(undefined, {
    refetchOnMountOrArgChange: true,
    pollingInterval: settled ? 0 : timing.pollMs,
  });
  const confirmed =
    before !== undefined && probe.data !== undefined && hasChanged(before, probe.data);
  const waiting = !settled && !confirmed && !timedOut;

  useEffect(() => {
    if (confirmed || timedOut) setSettled(true);
    if (confirmed) clearSnapshot();
  }, [confirmed, timedOut]);

  return (
    <PageFrame>
      <Card>
        {confirmed ? (
          <Banner message={copy.return.confirmed} />
        ) : waiting ? (
          <p role="status" className="text-body text-text">
            {copy.return.confirming}
          </p>
        ) : (
          <Banner message={copy.return.pending} />
        )}
        <Link
          to="/"
          className="text-body-strong font-bold text-text underline outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {copy.return.back}
        </Link>
      </Card>
    </PageFrame>
  );
}
