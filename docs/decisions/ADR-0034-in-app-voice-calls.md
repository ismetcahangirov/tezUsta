# ADR-0034 — Calling is in-app voice over LiveKit, not a masked phone number

- **Status:** Accepted
- **Date:** 22 September 2026
- **Context:** EPIC 18, issue #175
- **Supersedes:** nothing. Companion to
  [ADR-0033](ADR-0033-in-order-messaging.md), which decides the written channel.

## Context

Writing is not enough. A master standing outside the wrong building, or a
customer who has to describe a noise, needs to talk. And the same constraint
that shapes [ADR-0033](ADR-0033-in-order-messaging.md) applies harder here: the
obvious implementation is to show each party the other's phone number, and a
phone number given away is given away permanently.

There are two credible ways to let two strangers speak without exchanging
numbers, and they are not variations of one another.

## Decision

### 1. In-app voice calls over LiveKit

The two parties to an active order can call each other inside the app. Media
goes over WebRTC to a LiveKit SFU; no telephony network is involved and no
number is exposed.

The alternative — masked PSTN, the mechanism a ride-hailing app uses, where
both parties dial a proxy number that bridges the two real ones — is
considered in full below and was rejected. The deciding factor is not technical
merit: masked calling is better on every axis except one. It requires a
telephony provider with Azerbaijani numbering, a commercial relationship, and
operator registration. TezUsta has not been able to close that relationship for
**SMS** — "SMS provider + sender ID" is still the single red entry in
[`CLAUDE.md`](../../CLAUDE.md) § Decisions still open, and it is what stops
anybody signing in for real. Choosing a second, larger telephony dependency for
calling would put this feature behind the same unresolved negotiation.

LiveKit has no such gate. It is open source, self-hostable beside Postgres and
Redis in the same `docker-compose` the integration tests already require, and
the pattern is proven end to end in a sibling codebase under this owner.

### 2. Voice only

No video. The transport carries it, the SDK would give it nearly for free, and
adding it later is a small change — which is exactly why it is not in scope
now. Video doubles the permission surface, doubles the call UI, and is the
hardest thing to keep working on the mid-range Android device CLAUDE.md §12
names as the realistic one. The diagnostic case video would serve — _show me
the leak_ — is already served by the photographs on the order and by
attachments in the conversation.

### 3. Tokens are minted on accept, never on invite

A LiveKit access token is a bearer credential for a room. The server issues one
only when a call has actually been accepted, to each of the two parties, scoped
to that call's room, with `roomJoin`, `canPublish` and `canSubscribe` granted
explicitly rather than left to the server's defaults.

An invite carries no token. A declined or unanswered call therefore leaves no
credential anywhere.

Tokens are never logged. Nor are they put on `socket.data` — see
`realtime.types.ts` on why that object crosses Redis.

### 4. The ring/answer state machine is persisted server-side, signalled over the socket

A `calls` row exists from the invite and records every transition: ringing,
accepted, rejected, cancelled, timed out, busy, ended, and the reason. The
server is the authority on which call is live and on whether either party is
already on one; the clients hold a _pure reducer_ that translates inbound
frames into a phase, and ignore any event that does not apply to their current
phase so that a late or duplicated frame is harmless.

Signalling frames ride the gateway from [ADR-0032](ADR-0032-realtime-transport.md)
alongside messages. A call is refused when the callee has no live socket _and_
cannot be woken — see § 5.

The end of a call has three independent signals, and the design assumes each
one can fail:

- the peer's participant leaving the LiveKit room,
- the server finalizing the call (hangup, reaper, or the room disappearing),
- LiveKit's own terminal `Disconnected` event.

A screen that ends only on the first sits open on a dead room whenever the
second party's app is killed; a screen that ends on a _transient_ disconnect
kills calls that WebRTC would have recovered across a Wi-Fi handover. Both are
failure modes observed in the reference implementation and both are treated as
requirements here, not as polish.

### 5. An incoming call wakes the app

The reference implementation gates a call on the callee already holding a live
WebSocket and documents, in its own source, that this silently drops calls
whenever the app is not running. TezUsta does not repeat that: push is already
built (#141, #142), and a ringing call sends a high-priority push that the app
turns into a ringing screen.

This is the single hardest piece of client work in EPIC 18 and it is scoped as
its own issue for that reason.

### 6. A call is bound to the order, and to its life

The same rule as ADR-0033 § 2: either party may call the other while the order
is active, and neither can once it reaches a terminal status. A call is
recorded against the order, and an admin can read the record — who called, when,
how long, how it ended. Not its contents; nothing is recorded.

## The dependency is not yet proven, and the first issue is a gate

LiveKit's React Native SDK **publishes no React Native compatibility matrix**.
`@livekit/react-native-webrtc@144.2.0` declares `"react-native": ">=0.60.0"`
and `@livekit/react-native@3.0.0` declares `"react-native": "*"`. Neither range
means anything: they are the same uselessly-wide peer declaration CLAUDE.md § 3
already warns about for NativeWind, where a loose range let a broken pairing
install cleanly.

What is actually known, as of 22 September 2026:

| Package                             | Latest    | Published  | Peers                                                      |
| ----------------------------------- | --------- | ---------- | ---------------------------------------------------------- |
| `@livekit/react-native`             | `3.0.0`   | 2026-09-11 | `@livekit/react-native-webrtc@^144.2.0`, `react-native: *` |
| `@livekit/react-native-webrtc`      | `144.2.0` | 2026-09-11 | `react-native: >=0.60.0`                                   |
| `@livekit/react-native-expo-plugin` | `1.0.2`   | 2026-03-17 | `@livekit/react-native@^2.1.0`                             |

Two things follow. First, the Expo config plugin's peer range **excludes** the
current SDK major — `^2.1.0` does not admit `3.0.0` — so either the plugin is
stale or the `2.x` line is the supported pairing; that has to be established,
not guessed. Second, `apps/mobile` runs **Expo 57.0.22 / React Native 0.86.3**,
while the working reference implementation runs **Expo 54 / React Native
0.81.5**. Five minor React Native versions and a New Architecture cutover
separate the two, across a package that ships a forked WebRTC binary.

So the first call issue in EPIC 18 is **a build spike with a hard gate**, not an
implementation: produce a development build on Expo 57 / RN 0.86.3 and place a
real two-device call, or report that the pairing does not hold. Nothing else in
the calling half starts until it passes. If it fails, the fallbacks in order are
(a) the `2.x` SDK line with the plugin's declared pairing, (b) pinning
`apps/mobile` back to the newest Expo SDK LiveKit is proven on — which would
itself need an ADR — and (c) reopening masked PSTN.

**LiveKit also takes the app out of Expo Go.** Adding a WebRTC module means a
development build. `apps/mobile` uses continuous native generation and has no
checked-in `android/` or `ios/`, so this is a config plugin plus an EAS profile
rather than an ejection — but "run it in Expo Go" stops being true for everyone
working on the app, and that is a change to how the project is developed, not
just to what it contains.

## Alternatives considered

**Masked PSTN calling through a telephony provider.** Genuinely better on the
things that matter most for this market: it works with the app closed, on a
feature-phone-grade data connection, over a voice network engineered for exactly
this, and with no battery or permission story. It is what a ride-hailing app
does, and if the commercial relationship existed it would probably win.
Rejected because it requires an Azerbaijani telephony vendor and operator
registration — the same class of unresolved dependency that has blocked real
sign-in since EPIC 2 — and because the owner pointed at a working in-app
implementation as the reference. If call completion rates in the field turn out
poor, this is the decision to revisit, in a superseding ADR.

**Handing over a real phone number.** Rejected. It is permanent, unrevocable,
and outlives the order — the problem this Epic exists to solve.

**Twilio Video, Agora, Daily, or another hosted WebRTC vendor.** All viable,
all a commercial relationship and a per-minute bill, none offering anything
LiveKit does not for a 1:1 audio call. LiveKit is additionally self-hostable,
which keeps development and CI free of a vendor account and keeps the hosting
question inside the one that is already open (EPIC 17).

**Raw WebRTC with our own signalling and a TURN server.** Rejected on CLAUDE.md
§10: an SFU, ICE handling, reconnection and mobile-network edge cases are a
large amount of our own code to maintain in exchange for removing a dependency
that is open source and self-hosted anyway.

**Video calls now.** Rejected — § 2.

## Consequences

- Neither party ever sees the other's phone number.
- Calls require a data connection on both sides. On a bad connection the call
  degrades or fails where a PSTN call would have connected. This is the
  accepted cost of the decision, and the thing to measure in the field.
- The app requires a development build and an EAS profile; Expo Go stops being
  the way to run it.
- Microphone permission joins the app's permission set.
- A LiveKit deployment joins the operational surface — one more thing to host,
  which folds into the open hosting decision (EPIC 17). Local development and
  CI run it in `docker-compose`, as Postgres and Redis already are.
- Call _records_ exist — who, when, how long, outcome. Call _contents_ do not:
  nothing is recorded, and adding recording later would be a new ADR and a legal
  question, not a feature.
