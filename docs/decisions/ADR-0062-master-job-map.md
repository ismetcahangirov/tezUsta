# ADR-0062 — A map on the master's job screen while they are on the way

- **Status:** **Accepted (marker art and the four strings are the owner's to replace)**
- **Date:** 2026-10-25
- **Decided by:** Project owner. During the 25 October 2026 device check on a Galaxy A36, the owner asked for the map to open inside the app, and then chose the recommended option: on the job screen after accept, not on the offer card.
- **Context:** EPIC 9 (tracking). No issue: the auto-mode classifier denies `gh issue create` in this repository, so the pull request records the reason.
- **Builds on:** [ADR-0035](ADR-0035-customer-tracking-map.md) (the customer's tracking map and its `MapSurface` contract), [ADR-0036](ADR-0036-master-work-surface.md) (the master's job is one pushed screen), [ADR-0004](ADR-0004-location-and-maps.md) (Google Maps Platform).

## Context

The job screen showed the customer's address as text, with a "Xəritədə aç" button that hands the trip to the Google Maps app (EPIC 9 left turn-by-turn out of scope). A master on the device check could not see where the job was without leaving TezUsta.

The offer card deliberately carries no address, only a distance band. A broadcast reaches every eligible master and most of them never take the job (#101), so the exact address is given out only at accept. Nothing here changes that.

## Decision

1. **A map card on the job screen, after accept.** It shows the customer's address and this phone's own position. It is drawn by the same `MapSurface` the customer's tracking card uses, so `react-native-maps` stays behind one file and the markers are the interim art ADR-0035 already lists.
2. **Only at `ACCEPTED` and `MASTER_ON_THE_WAY`.** This is the window the customer's map has (ADR-0035 § 2) and the arrival countdown has (ADR-0055 § 12). From `MASTER_ARRIVED` there is nowhere left to find, and a native map is memory a mid-range phone should not spend on the street it is standing in.
3. **The master's own position comes from the phone, never from the server.** `useOwnPosition` reads the platform's last fix (`LocationPort.lastKnown`) every 10 s while the screen is focused. The reporter already keeps the provider warm during a job, so this adds no GPS work. It does not draw the master their own position from the reported point, which exists for dispatch and the customer.
4. **No fix, still a map.** Without a position the map frames the address alone, and a caption says the master's position is not known yet.
5. **The maps-app hand-off stays.** The "Xəritədə aç" button beside the address still opens Google Maps for turn-by-turn directions; the in-app map shows where the job is, not a route.

## Alternatives considered

- **A map on the offer card.** Rejected: it would show the customer's exact address to every master the broadcast reaches, reversing #101. A coarse zone is possible but nobody asked for it.
- **The platform's own "my location" dot** (`showsUserLocation`). It needs no position plumbing, but it adds a vendor prop to `MapSurfaceProps` and a second, platform-styled marker next to the token-built ones. Rejected for now; it is a one-file change if the owner prefers it.
- **A route line in the app.** Out of scope, as turn-by-turn was in EPIC 9. It would also need the Routes API on the client, and Google's terms forbid caching its geometry (ADR-0055).

## Consequences

- `JobDetail` takes an optional `location` port, injected by tests. The app uses the `expo-location` adapter.
- Four strings are placeholders for the owner, in `master-jobs-copy.ts` under `map`: the map's accessible name, the two marker labels, and the no-position caption.
- The map's style JSON is still the owner's (CLAUDE.md § 17). This card uses the platform's light and dark map, as the customer's does.
