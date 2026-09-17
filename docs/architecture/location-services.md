# Location services

TezUsta is fundamentally location-based. Four distinct capabilities are often
confused; they have different providers, costs, and failure modes.

| Capability             | What it does              | Where                                                                             |
| ---------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| **Device positioning** | The phone's own GPS fix   | `expo-location`                                                                   |
| **Map rendering**      | Drawing the map           | `react-native-maps`                                                               |
| **Geocoding**          | Address ↔ coordinates     | **Google Maps Platform** ([ADR-0004](../decisions/ADR-0004-location-and-maps.md)) |
| **Spatial query**      | "Who is within N metres?" | PostGIS, our own database                                                         |

**The spatial query is ours.** It runs on every order, so it must not depend on
a third-party API — that would put a network call and a per-request fee on the
critical path of order creation.

## Map rendering — `react-native-maps` (decided)

`expo-maps` was rejected: it is **alpha** by its own documentation, and on iOS it
renders **Apple Maps only**. A dispatch marketplace cannot have different map
data per platform — the same address would resolve differently for an iPhone
customer and an Android master. Full reasoning:
[ADR-0004](../decisions/ADR-0004-location-and-maps.md).

## Geocoding — **Google Maps Platform** (decided)

Chosen for one reason: **Baku address coverage is the requirement that cannot be
compromised, and Google is the only candidate where it is not in question.**
Mapbox was cheaper, but its own coverage announcements do not list Azerbaijan.

### Still required, despite the provider being chosen

**All geocoding goes through a provider interface, and no call site imports a
vendor SDK directly.** Choosing Google does not mean spreading its SDK through
the codebase — prices and terms change, and swapping providers must remain a
one-file change.

That interface lives in **`apps/api/src/infra/geo/`**, and moves to
`packages/config` when a second workspace needs it
([ADR-0016](../decisions/ADR-0016-shared-package-timing.md)). The location is
the only thing the timing rule changes: the interface is written as if it were
already a package, with no Google type crossing the boundary, so the extraction
is a file move rather than a redesign.

**Geocoding results are cached in Postgres**, keyed by normalised address. The
same Baku addresses recur constantly, so **the cache is the single largest lever
on the Google Maps bill** — without it the invoice grows with traffic rather
than with distinct addresses.

**Key handling:**

- Server key: IP-restricted, minimum API scope, never in the client bundle.
- Mobile keys: restricted by bundle id / package name.
- **Never behind `EXPO_PUBLIC_`** for anything with billing power — that prefix
  embeds the value in the shipped app.

## Azerbaijani addresses

A coordinate is frequently not enough to find a door in Baku. The address model
must carry structured detail beyond a formatted string:

- Building / block
- **Entrance (`giriş` / подъезд)**
- Floor
- Apartment
- Free-text landmark note

Masters lose real time on incomplete addresses. This field set is a product
requirement, not a nicety — and it is why a saved address is preferred over a
one-off geocode.

**Implemented** in EPIC 4 (issue #35) as the `addresses` table and
`/addresses` CRUD. Every field above is its own column, and every one of them
is `text`: an entrance is "2" but also "B", a floor is "5" but also
"zirzəmi", and a numeric column would force the customer to leave it blank —
which is the failure the field set exists to prevent.

## Positioning policy

Accuracy costs battery. Match accuracy to purpose:

| Purpose                 | Accuracy   | Why                                           |
| ----------------------- | ---------- | --------------------------------------------- |
| Order address (one-off) | High       | Used once; correctness matters                |
| Master online, idle     | Balanced   | Coarse position is enough for dispatch radius |
| Master travelling       | High       | Drives the customer's live view               |
| Master working          | Low / none | Stationary                                    |

**Distance filtering happens on-device first.** `expo-location`'s
`distanceInterval` suppresses updates natively without waking the JS thread — far
cheaper than filtering in JavaScript. Full budget:
[`realtime-architecture.md`](realtime-architecture.md).

## Permissions

The highest-friction moment in the app.

1. **Foreground, at the point of need** — when setting an order location or
   going online. Never at first launch.
2. **Background, only when an order is accepted**, with a plain explanation of
   why. Stop when the order ends.
3. **Every denial has a path forward** — manual address entry. A denied
   permission must not dead-end the flow.
4. Handle "granted once", "while using", and permanent denial distinctly; guide
   the user to settings where relevant.
5. Android battery optimisation will kill background reporting. Detect stale
   reporting and warn the master rather than silently showing them as active.

## Distance and ETA

| Measure                    | Source                | Use                                                 |
| -------------------------- | --------------------- | --------------------------------------------------- |
| **Straight-line distance** | PostGIS `ST_Distance` | Matching, sorting, radius filter — free and instant |
| **Road distance / ETA**    | Provider routing API  | Displayed ETA only                                  |

**Matching uses straight-line distance.** Calling a routing API for every
candidate master on every order would be slow and expensive, for a ranking that
straight-line distance approximates well at city scale.

Routing is called **once**, for the assigned master, to show the customer an ETA.

Baku has water and bridges, so straight-line distance will occasionally mis-rank
a candidate. That is an acceptable ranking error; it is not acceptable in a
displayed ETA, which is why the two use different sources.

## Privacy

**A master's live position is personal data, and so is a customer's home
address.**

| Rule                                                                         |                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Live position visible only to the customer on the **active** order           | Not before assignment, not after completion                                     |
| Location history is retention-bounded                                        | Aged out on a schedule ([`database-architecture.md`](database-architecture.md)) |
| Precise coordinates are **never logged**                                     | Not in application logs, not in traces                                          |
| A customer's exact address is revealed to a master **only after acceptance** | Before that, an approximate area is sufficient                                  |
| Tracking stops when the order ends                                           | Continuing is a privacy violation and an app-store review failure               |

The "approximate area before acceptance" rule matters: broadcasting exact home
addresses to every nearby master on every order would leak the addresses of
people who never became customers.
