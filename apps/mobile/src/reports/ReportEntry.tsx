import { skipToken } from '@reduxjs/toolkit/query';

import { Button } from '../components';
import { REPORTS_COPY as copy } from './report-copy';
import { useReportPartiesQuery } from './report-endpoints';

export interface ReportEntryProps {
  /** The order to ask about, or `null` to show nothing and make no request. */
  readonly orderId: string | null;
  readonly onPress: (orderId: string) => void;
}

/**
 * "Problem bildir" on the order and job screens (#330, ADR-0053): a small,
 * quiet button — a report is the exception, not the screen's subject.
 *
 * Shown only while the server says someone may be reported, or once the
 * reader has filed a report, when it reads "Problem bildirildi" and opens it.
 * Nothing while it loads or fails: an entry is an option, not information.
 */
export function ReportEntry({ orderId, onPress }: ReportEntryProps): React.JSX.Element | null {
  const parties = useReportPartiesQuery(orderId ?? skipToken);
  const current = parties.currentData;

  if (orderId === null || current === undefined) {
    return null;
  }
  const filed = current.some((party) => party.report !== null);
  const open = current.some((party) => party.open);
  if (!filed && !open) {
    return null;
  }

  return (
    <Button
      label={filed ? copy.entryDone : copy.entry}
      accessibilityHint={filed ? copy.entryDoneHint : undefined}
      variant="ghost"
      size="sm"
      onPress={() => {
        onPress(orderId);
      }}
    />
  );
}
