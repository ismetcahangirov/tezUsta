# ADR-0004 — Map rendering and geocoding provider

- **Status:** **Partially accepted.** Map library decided; provider **PENDING user decision**.
- **Date:** 2026-09-14

## Context

TezUsta needs, on both iOS and Android:

- a rendered map (order location, master position, live tracking)
- forward geocoding (address text → coordinates)
- reverse geocoding (coordinates → a human-readable Baku address)
- distance and ETA between master and customer

The market is Azerbaijan, starting in Baku. Address-level coverage there is the
deciding factor and cannot be assumed from a provider's global reputation.

---

## Part 1 — Map library: `react-native-maps` (ACCEPTED)

**Decision:** `react-native-maps@1.29.2`.

**Why not `expo-maps`,** despite it being first-party and more modern
(SwiftUI / Jetpack Compose)? Its own documentation states two disqualifying facts:

1. **"This library is currently in alpha and will frequently experience breaking changes."**
2. On iOS it renders **Apple Maps only** — _"While Google provides a Google Maps
   SDK for iOS, Expo Maps supports it exclusively on Android."_

A dispatch marketplace cannot use different map data per platform. Place
identifiers, geocoding results, and rendered geometry would differ between an
iPhone customer and an Android master looking at the same address. Debugging a
mismatched-location report would mean asking which platform the user was on.

`react-native-maps` renders Google Maps on both platforms, is stable, and is
documented by Expo.

**Revisit when:** `expo-maps` leaves alpha _and_ supports one provider across
both platforms.

---

## Part 2 — Geocoding provider: PENDING

**This decision is not ours to make alone.** It depends on budget and on
verified Baku address coverage.

| Provider                      | For                                                                                                                        | Against                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Google Maps Platform**      | Best Azerbaijani address and POI coverage; single provider for maps, geocoding, Distance Matrix and ETA; mature RN support | Most expensive at volume; requires a billing account; keys must be restricted per platform                                                                                                              |
| **Mapbox**                    | Cheaper at volume; strong styling and offline support                                                                      | Azerbaijani street-level coverage **not confirmed** — Mapbox's own coverage expansion announcements do not list Azerbaijan. Would need validation against real addresses before it could be considered. |
| **OpenStreetMap / Nominatim** | Free; OSM Baku coverage is reasonable                                                                                      | Nominatim's public endpoint forbids production use; self-hosting is genuine operational work; no ETA or routing                                                                                         |

### Recommendation

**Google Maps Platform for launch**, for one reason: coverage in Baku is the
requirement that cannot be compromised, and it is the only candidate where that
is not in question. Cost is manageable at launch volume and becomes a
renegotiable problem later; wrong addresses at launch are not recoverable.

### Required regardless of provider

Access sits behind a **provider interface** so the choice stays reversible:

- `packages/config` exports the active geocoding provider.
- **No call site imports a vendor SDK directly.** Swapping providers must be a
  one-file change, not a search-and-replace across the app.
- Geocoding results are cached in Postgres keyed by normalised address — the
  same addresses recur constantly, and this is the single largest lever on cost.
- Server-side keys are IP-restricted; mobile keys are restricted by bundle id /
  package name and carry the minimum API scope.
- A server-side key must **never** appear behind the `EXPO_PUBLIC_` prefix, which
  ships it in the app bundle.

### What is needed to finalise

1. The user's budget ceiling for maps and geocoding.
2. A coverage spot-check: a sample of real Baku addresses — including apartment
   blocks and less-central districts — geocoded through each candidate and
   compared.

Until this is resolved, no code may hardcode a provider.
