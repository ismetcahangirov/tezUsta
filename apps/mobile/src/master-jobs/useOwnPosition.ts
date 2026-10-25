import { useEffect, useState } from 'react';

import type { LocationPort, Position } from '../location/location-port';

/**
 * How often the job map re-reads where this phone is. The reporter already
 * keeps the platform's location provider warm while the master works, so this
 * reads the fix it last produced (`lastKnown`) rather than asking for a new
 * one: no extra GPS work, and a marker that is never more than this far behind.
 */
export const OWN_POSITION_REFRESH_MS = 10_000;

/**
 * This phone's own position, for the master's job map (ADR-0062). `null` until
 * the platform has a fix, and whenever it never gets one: the map then shows
 * the customer's address alone, which is still the thing the master needs.
 *
 * Read on the phone, never from the server. The master's reported point exists
 * for dispatch and for the customer, and drawing a master their own position
 * from a round trip would be slower and no more true.
 *
 * The same coordinates keep the same object, so a refresh that found the master
 * standing still re-renders nothing below it.
 */
export function useOwnPosition(port: LocationPort, active: boolean): Position | null {
  const [position, setPosition] = useState<Position | null>(null);

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    let cancelled = false;
    const read = () => {
      // Through a resolved promise, so a port that throws synchronously costs
      // one missing marker rather than the screen.
      void Promise.resolve()
        .then(() => port.lastKnown())
        .then((next) => {
          if (cancelled || next === null) return;
          setPosition((previous) =>
            previous !== null &&
            previous.latitude === next.latitude &&
            previous.longitude === next.longitude
              ? previous
              : next,
          );
        })
        .catch(() => {
          // No fix is not an error worth a banner: the address is still drawn.
        });
    };
    read();
    const timer = setInterval(read, OWN_POSITION_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [port, active]);

  return position;
}
