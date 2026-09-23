# ADR-0035 — The customer watches the master on a map card under the status card

- **Status:** **Accepted** (interim owner art and copy listed below, awaiting
  the owner's acceptance; frame-rate measurement on a mid-range Android device
  outstanding)
- **Date:** 2026-09-23
- **Context:** EPIC 9, issue [#172]
- **Amends:** [ADR-0029](ADR-0029-customer-order-screen.md) § 8 ("the screen
  shows no … position"), which deferred the master's position to "the tracking
  surface of EPIC 9". This is that surface. The rest of ADR-0029 stands: the
  status card still leads the screen and the screen still does not act.
- **Supersedes in part:** [ADR-0004](ADR-0004-location-and-maps.md) Part 1's
  version number only. The library decision (`react-native-maps`, Google Maps
  on both platforms) is unchanged; the pin is the SDK 57 version, see
  _The dependency_.
- **Decided by:** the project owner delegated every design and product decision
  in #172 rather than supplying a layout. CLAUDE.md §17's "stop and ask" rule is
  answered for this surface only. Everything genuinely owner-owned is shipped as
  interim and listed under _Interim, owner-owned_.

[#172]: https://github.com/ismetcahangirov/tezUsta/issues/172

## Context

The server fans the master's position out to the customer on the order (#169),
throttled to one point per `REALTIME_POSITION_FANOUT_SECONDS` (15 s), and the app
receives it into an RTK Query cache entry with no endpoint behind it (#170,
`tracking-endpoints.ts`). Nothing drew it. The question #10 exists to answer — a
customer waiting for a master has no information — was still unanswered on the
one screen built for it.

Drawing a point is not the decision. The decisions are where the map sits, when
it exists at all, what it says when the point is old or missing, and how a
marker that receives one point every fifteen seconds is made to look like a
person moving.

## Decision

### 1. A card directly under the status card — not a full-screen map, not above it

The order screen stays what ADR-0029 made it: the status card first, then the
tracking card, then the order's details. The tracking card holds a heading, a
square map (`aspect-square`, full card width — a ratio, so no size token had to
be invented) and one sentence naming the state.

- **Not a full-screen map with a sheet over it** (the Bolt layout the
  design-system reference hints at under "Sheets"). That is a navigation
  pattern, it would make the map the screen's subject for the ten minutes it
  matters and an empty picture for the rest of the order's life, and it would
  demote the status card that ADR-0029 settled as the lead.
- **Not above the status card.** The status and its next step remain the answer
  to "where is my order"; the map adds the one thing the card cannot say — how
  far away — and so it follows it.
- **A picture, not a control.** Pan, zoom, rotate and tilt are off. The map
  lives inside the screen's `ScrollView`, where a pannable map steals the scroll
  gesture from the rest of the order. The camera frames the customer's address
  and the master's reported point by itself, once per report.

### 2. Shown in `ACCEPTED` and `MASTER_ON_THE_WAY` only

`tracking-policy.ts` maps all fourteen statuses, total over `OrderStatus`.

- **Before an accept** there is no master and the server sends nothing.
- **`MASTER_ARRIVED` and `IN_PROGRESS` hide it**, although the server still fans
  a position out in both. The master is at the door, the question is answered,
  and the working floor is 120 s — the map would spend the whole job saying
  "stale". Drawing a person's position when nobody needs it is what CLAUDE.md
  §11 asks us not to do with PII. Outside the tracked statuses the cache entry
  is not even subscribed, and `keepUnusedDataFor: 0` drops the last point.
- **Every terminal status hides it**, and a late frame for a finished order
  finds no subscribed entry to land in.

### 3. Four honest states besides hidden

| State          | When                                                                               | What the customer sees                                                   |
| -------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `absent`       | Tracked status, no point received                                                  | No map. "No position yet", and that the rest of the order works anyway   |
| `live`         | A point received within the freshness window, over the connection that is live now | Map, accent marker that moves, "live" sentence                           |
| `stale`        | A point older than the window, or received before the connection last came back    | Map, muted marker placed on the last point, never animated, "stale"      |
| `reconnecting` | The socket dropped and is retrying                                                 | Last point muted if there is one, "reconnecting"; no map if there is not |

- **No position, no map.** A native map view showing only the customer's own
  address costs memory and GPU on a mid-range Android for a picture of where
  the customer already is. The map mounts when the first point arrives.
- **The absent state does not guess why.** Location denied on the master's
  phone, a reporter killed by battery optimisation and a socket that never came
  up all look the same from here; a sentence that picked one would usually be
  wrong.
- **A point from before a gap is never live after it**, however young it is by
  the clock. The socket does not replay and the position has no endpoint to
  refetch (`RealtimeProvider`, `onResumed`), so after a reconnect only a point
  that arrives over the restored connection may be called live. The order
  itself is refetched over HTTP, and when that says the order has moved on —
  arrived, cancelled — the map goes with it.

### 4. The freshness window is derived: 39 s

`POSITION_FRESHNESS_MS = (15 + 2 × 12) s`. The fan-out is leading-edge, so the
worst gap between two broadcasts from a healthy travelling master is one window
plus one reporting floor (15 + 12 = 27 s). One more floor absorbs a single late
report without calling a healthy master stale, and stays short of the master
app's own three-missed-floors staleness. The server's 15 s is a transcribed
default (`SERVER_POSITION_FANOUT_SECONDS`) because it is configuration, not a
contract; the constant's comment says which direction a change on the server
would drift it.

**Freshness is measured from when the point reached this phone**, not from the
payload's `at`. `at` is the server's clock and `now` is the phone's; a phone
running a minute slow would draw a two-minute-old point as live. The receipt
time is stamped where the frame lands (`applyRealtimeEvent`) and stored in the
same cache entry, so there is still one store. It is honest about age because
the server never holds a point back. `at` keeps its one job, ordering.

### 5. The marker glides between reports, in JavaScript, at 4 Hz

Smoothness is a rendering problem; the fan-out rate does not change. Between
two live points the marker travels linearly over one fan-out window (15 s),
redrawn every 250 ms — at street zoom a car covers a metre or two in that time,
below a pixel, so a faster tick buys nothing visible and costs a JS render per
frame. A glide always finishes before its point could turn stale (15 s < 39 s).

It glides **only from a point that was live when the new one arrived**. The
first point, the first after a stale spell, and the first after a reconnect are
placed, not animated: a path from an old point is a route the master may never
have taken. When the point stops being live mid-glide, the marker is set down on
the reported point — a real one — and stops.

The native `animateMarkerToCoordinate` would have been cheaper. It is not
implemented for Google Maps on iOS in `react-native-maps@1.27.2` (the command
exists only in `ios/AirMaps`, Apple's provider), and ADR-0004 requires Google on
both platforms; one JS implementation behaves the same everywhere and is
testable under Jest.

The camera re-frames once per **report** (natively, animated), never per tick.

### 6. Themed through the platform's own light and dark map

`userInterfaceStyle` follows the app theme; both platforms support it in 1.27.2.
It is the one theming lever that needs no colour invented. Markers and every
surface around the map use tokens only.

### 7. No hand-off to a maps application

Turn-by-turn is the master's concern and out of scope (#10). The customer has
nothing to navigate to — the master is coming to them — so no "open in Maps"
link is shipped; it would be a control whose use nobody has described.

## The dependency

`react-native-maps@1.27.2`, installed with `npx expo install`: the version
`expo@57.0.22`'s `bundledNativeModules.json` names for SDK 57. ADR-0004 recorded
`1.29.2` when the package was still "planned"; `technology-stack.md` says the
pin is to be re-checked at install time against Expo's compatibility service,
and 1.29.x is newer than the SDK has been tested with. MIT; peers
`react >= 18.3.1`, `react-native >= 0.76.0`, optional `react-native-web >= 0.11`
— satisfied by 19.2.3 / 0.86.3 / 0.21.2; one dependency, `@types/geojson`.
Details in `docs/engineering/dependency-policy.md`.

**Keys.** The config plugin reads `EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY` and
`EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY` from the environment at build time
(`app.config.js`) — the one documented `EXPO_PUBLIC_` exception, restricted by
package name and scoped to the Maps SDK. No key is committed or invented.
Without an iOS key the plugin does not install the Google Maps SDK pod, so a
development build falls back to Apple Maps rather than drawing an error; that
fallback is **development-only** and a release build must set both keys.
Without an Android key Android draws blank tiles.

**Boundary.** `src/tracking/map-surface.tsx` is the only file that imports the
library; `map-surface.web.tsx` is a token-styled stand-in so Storybook (React
Native Web) builds; Jest replaces the adapter for every suite
(`test/support/fake-map-surface.tsx`) and tests the adapter itself against a
stubbed vendor module.

## Interim, owner-owned

Shipped so the feature works, each awaiting the owner's acceptance or
replacement. None of them should be treated as final because it shipped.

- **Google Maps style JSON** — not supplied. The platform's default map, light
  or dark by theme, is used until it is (ADR-0011 lists it as owner art).
- **Master marker** — a 32 px (`avatar-sm`) circle: `accent` fill with an
  `on-accent` ring when live, `surface-alt` with a `text-muted` ring when stale.
  Built from existing tokens and sizes; no icon set was invented.
- **Destination marker** — the same size in `inverse-surface` with a `surface`
  ring and an `on-inverse` centre dot.
- **The map's proportion** — square, full card width.
- **Motion** — the glide is linear and functional (it tracks a moving person).
  It is not the owner's motion language, which remains unspecified; the camera
  uses `react-native-maps`' own animation.
- **Copy** — every string in `src/tracking/tracking-copy.ts` is placeholder:
  the heading ("Usta haradadır"), the map's accessible name, both marker names,
  and the live, stale, absent (title and description) and reconnecting
  sentences.

## Alternatives considered

| Option                                                   | Why not                                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full-screen map with the order in a sheet                | A navigation pattern, and one that makes the map the subject for the whole order's life; demotes the status card ADR-0029 settled                                   |
| Show the map in all four statuses the server fans out in | At `MASTER_ARRIVED`/`IN_PROGRESS` the master is at the door and reports every 120 s: the map would be permanently "stale" and a person's position shown for nothing |
| Judge freshness by the payload's `at`                    | Two clocks. A slow phone draws old points as live                                                                                                                   |
| Native `animateMarkerToCoordinate`                       | Not implemented for Google Maps on iOS in 1.27.2                                                                                                                    |
| `Animated` / `AnimatedRegion` at 60 fps                  | A JS-driven animation per frame for sub-pixel movement on the device with the least to spare                                                                        |
| Raise the fan-out rate for smoothness                    | Ruled out in `realtime-architecture.md`; costs battery and data on both phones for precision a map cannot show                                                      |
| Always mount the map, with the address alone when absent | A native view spent on a picture of where the customer is standing                                                                                                  |
| `expo-maps`                                              | Rejected in ADR-0004 (alpha; Apple Maps only on iOS). Unchanged                                                                                                     |

## Trade-offs accepted

- **Frame rate on a mid-range Android is not measured.** The design is chosen to
  be cheap — 4 Hz marker renders, camera moves once per report, marker bitmaps
  snapshotted once, no map at all until a point exists — but #172's
  acceptance criterion "does not drop frames noticeably" needs a device and a
  profiler, and this change was not run on one. #173 is where the budget is
  measured; this ADR's numbers are the first thing it should revisit.
- **The marker lags the master by up to one window.** Gliding towards the last
  reported point over 15 s draws where the master was, not where they are.
  Extrapolation would draw where they might be, which is the invented path this
  ADR refuses.
- **The freshness window copies a server default.** An operator raising
  `REALTIME_POSITION_FANOUT_SECONDS` must revisit it.
- **An iOS development build without a key shows Apple Maps**, which ADR-0004
  would not accept in production.

## Consequences

- `src/tracking/` holds the feature; `OrderDetail` renders `MasterTracking`
  under the status card.
- The tracking cache entry now carries `receivedAt` beside the server payload
  (`ReceivedMasterPosition`).
- `jest.setup.js` replaces the map adapter for every suite.
- `app.config.js` registers the `react-native-maps` config plugin; changing a
  map key needs a new native build.

## Revisit when

- #173 measures frame rate, battery and the reporting floor on real hardware.
- The owner supplies the map style JSON, marker art, motion language or copy.
- `react-native-maps` implements native marker animation for Google on iOS, or
  Expo moves the SDK's bundled version.
- A master-facing job screen exists and wants the same surface in reverse.
