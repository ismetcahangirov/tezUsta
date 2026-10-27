import { useEffect, useState } from 'react';

/**
 * Whether the master's hand-back window is still open
 * ([ADR-0068](../../../../docs/decisions/ADR-0068-cancellation-rules.md) § 4),
 * flipping to `false` on its own when `until` passes.
 *
 * **Only whether to offer the control.** The server decides the hand-back
 * itself against its own clock, so a phone whose clock runs slow shows the
 * button a little too long and is refused — the screen handles that refusal —
 * rather than the phone being trusted.
 */
export function useHandBackOpen(until: string | undefined): boolean {
  const deadline = until === undefined ? Number.NaN : Date.parse(until);
  const [open, setOpen] = useState(() => Date.now() < deadline);

  useEffect(() => {
    const remaining = deadline - Date.now();
    setOpen(remaining > 0);
    if (!(remaining > 0)) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setOpen(false);
    }, remaining);
    return () => {
      clearTimeout(timer);
    };
  }, [deadline]);

  return open;
}
