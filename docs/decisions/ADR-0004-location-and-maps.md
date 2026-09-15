# ADR-0004 — Map rendering and geocoding provider

- **Status:** **Accepted** (map library and geocoding provider both decided)
- **Superseded in part by:** [ADR-0016](ADR-0016-shared-package-timing.md) —
  the clause placing the provider interface in `packages/config`. The decision
  itself (Google Maps Platform behind a provider interface) is unchanged.
- **Date:** 2026-09-14
- **Provider decided by:** Project owner

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

## Part 2 — Geocoding provider: **Google Maps Platform** (ACCEPTED)

Decided by the project owner, matching the recommendation below.

| Provider                      | For                                                                                                                        | Against                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Google Maps Platform**      | Best Azerbaijani address and POI coverage; single provider for maps, geocoding, Distance Matrix and ETA; mature RN support | Most expensive at volume; requires a billing account; keys must be restricted per platform                                                                                                              |
| **Mapbox**                    | Cheaper at volume; strong styling and offline support                                                                      | Azerbaijani street-level coverage **not confirmed** — Mapbox's own coverage expansion announcements do not list Azerbaijan. Would need validation against real addresses before it could be considered. |
| **OpenStreetMap / Nominatim** | Free; OSM Baku coverage is reasonable                                                                                      | Nominatim's public endpoint forbids production use; self-hosting is genuine operational work; no ETA or routing                                                                                         |

### Why Google Maps Platform

**Coverage in Baku is the requirement that cannot be compromised, and Google is
the only candidate where it is not in question.** Cost is manageable at launch
volume and stays renegotiable; wrong addresses at launch are not recoverable.

Mapbox was the cheaper option, but its own coverage announcements do not list
Azerbaijan, so its street-level address data there is unverified. Adopting it
would have meant betting the core of the product on an assumption.

### Still required, despite the provider being chosen

Choosing Google does **not** mean spreading its SDK through the codebase. Access
sits behind a **provider interface** so the choice stays reversible — prices and
terms change, and swapping providers must remain a one-file change:

- `packages/config` exports the active geocoding provider.
- **No call site imports a vendor SDK directly.** Swapping providers must be a
  one-file change, not a search-and-replace across the app.
- Geocoding results are cached in Postgres keyed by normalised address — the
  same addresses recur constantly, and this is the single largest lever on cost.
- Server-side keys are IP-restricted; mobile keys are restricted by bundle id /
  package name and carry the minimum API scope.
- A server-side key must **never** appear behind the `EXPO_PUBLIC_` prefix, which
  ships it in the app bundle.

### Cost control — the one thing that matters operationally

**The geocode cache is the single largest lever on the bill.** The same Baku
addresses recur constantly; without a cache keyed on the normalised address, the
Google Maps invoice grows with traffic rather than with distinct addresses.

Second lever: **matching does not call a routing API.** Ranking nearby masters
uses PostGIS straight-line distance — free and instant. Google's Distance Matrix
is called **once**, for the assigned master, to show the customer an ETA. Calling
it per candidate on every order would be both slow and expensive.

### Operational setup still required

- [ ] Google Cloud project with a **billing account**
- [ ] A monthly budget cap and alert, against an accidental request spike
- [ ] APIs enabled: Maps SDK (Android + iOS), Geocoding API, Distance Matrix API
- [ ] Server key restricted by IP; mobile keys restricted by bundle id / package name
- [ ] Confirm no key sits behind `EXPO_PUBLIC_`
