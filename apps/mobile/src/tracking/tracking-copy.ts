/**
 * Every customer-facing string on the tracking surface (issue #172).
 *
 * **Placeholder, not settled** — the same standing as `orders-copy.ts`. The
 * design system fixes colour, type and components, not words, and CLAUDE.md
 * §17 keeps the content of an empty or degraded state with the owner. Each
 * string is listed in the pull request and in
 * [ADR-0035](../../../../docs/decisions/ADR-0035-customer-tracking-map.md) for
 * the owner to accept or replace.
 *
 * **Each state says what it knows and nothing more.** "No live position" does
 * not guess *why* — the master may have denied location, their phone may have
 * killed the reporter, or this phone's connection may never have come up — and
 * a sentence that picked one would be wrong most of the time.
 */
export const TRACKING_COPY = {
  title: 'Usta haradadır',
  mapLabel: 'Ustanın və ünvanınızın xəritəsi',
  masterMarker: 'Usta',
  masterMarkerStale: 'Ustanın son məlum mövqeyi',
  destinationMarker: 'Sizin ünvanınız',

  live: 'Canlı: usta xəritədə hərəkət etdikcə yenilənir.',
  stale: 'Mövqe köhnəlib. Xəritədə ustanın son məlum yeri göstərilir.',
  absentTitle: 'Ustanın mövqeyi hələ yoxdur',
  absentDescription:
    'Usta mövqeyini paylaşanda burada görünəcək. Sifarişin qalan hissəsi bundan asılı deyil.',
  reconnecting: 'Bağlantı bərpa olunur…',
} as const;
