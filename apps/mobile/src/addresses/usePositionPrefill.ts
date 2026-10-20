import type { ReverseGeocodedAddress } from '@tezusta/types';
import { useCallback, useState } from 'react';

import { locationAdapter } from '../location/location-adapter';
import type { LocationPort, Position } from '../location/location-port';
import { useReverseGeocodeMutation } from './addresses-endpoints';

/**
 * How long the one fix may take. Long enough for a balanced fix indoors on a
 * mid-range Android, short enough that the customer is typing before they
 * wonder whether anything is happening.
 */
export const PREFILL_FIX_TIMEOUT_MS = 10_000;

/** Why a prefill gave nothing. Each one leaves manual entry exactly as it was. */
export type PrefillFailure = 'denied' | 'no-fix' | 'no-result' | 'unavailable';

export type PrefillOutcome =
  | {
      readonly status: 'ok';
      /** The phone's own fix — the point the customer is standing at. */
      readonly position: Position;
      readonly address: ReverseGeocodedAddress;
    }
  | { readonly status: PrefillFailure };

export interface PositionPrefill {
  /** Asks for permission if it may, takes one fix and reverse-geocodes it. Never throws. */
  readonly run: () => Promise<PrefillOutcome>;
  readonly pending: boolean;
  /** The last failure, for one sentence under the control. Cleared by the next run. */
  readonly failure: PrefillFailure | null;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out'));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('no fix'));
      },
    );
  });
}

/**
 * "Fill the new address from where I am" (issue #413).
 *
 * **Permission at the point of need**, never at launch
 * (`location-services.md` § Permissions): the prompt appears only when the
 * customer taps the control, and only if the platform would still show one.
 * A refusal — now or earlier — is an answer, not an error: manual entry is
 * untouched, and the control says so in one sentence.
 *
 * **One balanced fix**, not a watch: Wi-Fi and cell are enough to name the
 * building, and a GNSS fix indoors is slow and battery-hungry on the phones
 * this market uses. Bounded by {@link PREFILL_FIX_TIMEOUT_MS}.
 *
 * Nothing here logs the position — it is PII (`security.md`).
 */
export function usePositionPrefill(port: LocationPort = locationAdapter): PositionPrefill {
  const [reverseGeocode] = useReverseGeocodeMutation();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<PrefillFailure | null>(null);

  const attempt = useCallback(async (): Promise<PrefillOutcome> => {
    let permission = await port.permission();
    if (permission === 'askable') {
      permission = await port.requestPermission();
    }
    if (permission !== 'granted') {
      return { status: 'denied' };
    }

    let position: Position;
    try {
      position = await withTimeout(port.current('balanced'), PREFILL_FIX_TIMEOUT_MS);
    } catch {
      return { status: 'no-fix' };
    }

    try {
      const result = await reverseGeocode({
        latitude: position.latitude,
        longitude: position.longitude,
      }).unwrap();
      return result.status === 'ok'
        ? { status: 'ok', position, address: result.address }
        : { status: result.status };
    } catch {
      // Offline, or the server refused — the same answer to the customer as
      // the map service being down: carry on typing.
      return { status: 'unavailable' };
    }
  }, [port, reverseGeocode]);

  const run = useCallback(async (): Promise<PrefillOutcome> => {
    setPending(true);
    setFailure(null);
    let outcome: PrefillOutcome;
    try {
      outcome = await attempt();
    } catch {
      // A permission call that rejected: as good as no fix.
      outcome = { status: 'no-fix' };
    }
    setPending(false);
    setFailure(outcome.status === 'ok' ? null : outcome.status);
    return outcome;
  }, [attempt]);

  return { run, pending, failure };
}
