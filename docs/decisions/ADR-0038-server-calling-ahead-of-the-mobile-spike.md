# ADR-0038 — The server half of calling does not wait on the mobile spike

- **Status:** Accepted
- **Date:** 2026-09-24
- **Amends:** [ADR-0034](ADR-0034-in-app-voice-calls.md) § "The dependency is
  not yet proven", for its sentence _"Nothing else in the calling half starts
  until it passes"_. Every other part of ADR-0034 stands.
- **Decided by:** the project owner delegated the decisions in EPIC 18 on
  2026-09-24 ("decide professionally, do not ask").
- **Issues:** [#183], [#184], [#185], [#186], [#187]

[#183]: https://github.com/ismetcahangirov/tezUsta/issues/183
[#184]: https://github.com/ismetcahangirov/tezUsta/issues/184
[#185]: https://github.com/ismetcahangirov/tezUsta/issues/185
[#186]: https://github.com/ismetcahangirov/tezUsta/issues/186
[#187]: https://github.com/ismetcahangirov/tezUsta/issues/187

## Context

ADR-0034 made #183 — a development build on Expo 57 / React Native 0.86 and a
held call between two real devices — a gate in front of the whole calling half.
The reason was sound and still is: `@livekit/react-native` publishes no React
Native compatibility matrix, declares `react-native: *`, and its Expo config
plugin peers a major the SDK has already left. A loose range can install a
broken pairing cleanly.

As of 2026-09-24 the gate cannot be run. `adb devices` lists nothing, and the
spike needs two physical devices, one a mid-range Android phone. Held literally,
the gate stops six issues on hardware, and four of those six contain no React
Native code at all.

The risk the gate guards is specific: **the mobile SDK does not hold a call on
this app's React Native version.** Which work does that risk touch?

| Work                                       | Uses the RN SDK? | Survives fallback (a) 2.x SDK | (b) older Expo | (c) masked PSTN      |
| ------------------------------------------ | ---------------- | ----------------------------- | -------------- | -------------------- |
| #184 provider port, server SDK, token mint | no               | yes                           | yes            | port yes, adapter no |
| #185 ring/answer state machine, `calls`    | no               | yes                           | yes            | records yes, ring no |
| #186 webhook, reaper, admin call records   | no               | yes                           | yes            | records yes, rest no |
| #187 reducers, signalling hook             | no               | yes                           | yes            | no                   |
| #187 room bridge, #188 screens, #189 wake  | **yes**          | —                             | —              | —                    |

Fallbacks (a) and (b) keep LiveKit on the server unchanged. Only (c) — the last
resort, which ADR-0034 says would need its own superseding ADR — would throw
server work away, and even then the call records, the order binding and the
admin surface carry over.

`livekit-server-sdk` is a separate package with its own constraints. On
2026-09-24 the registry reports `2.19.1` (published 2026-09-20), Apache-2.0,
`engines.node >=19`, three runtime dependencies (`jose`, `@livekit/protocol`,
`@bufbuild/protobuf`) and no peers. The API runs Node 24. #184's own text
already separated it: _"its constraints are not the mobile SDK's"_.

## Decision

1. **#184, #185 and #186 proceed now.** They depend on `livekit-server-sdk` and
   on a LiveKit server in `docker-compose` and CI, both of which can be verified
   on this machine. The server SDK is pinned by the ordinary dependency policy,
   not by #183.
2. **#187's pure half proceeds when #185 has landed**: the two reducers, the
   signalling hook and their exhaustive tests. They import nothing from LiveKit.
3. **Nothing from `@livekit/*` enters `apps/mobile` until #183 reports.** The
   room bridge in #187, the screens in #188 and the wake-up in #189 stay behind
   the gate. That is the part of ADR-0034 this ADR does not touch.
4. #183 stays open and blocked on hardware. When it reports, a negative result
   is handled exactly as ADR-0034 lists; this ADR does not pre-empt the choice.

## Alternatives considered

| Option                                   | Why not                                                                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the gate literal                    | Stops server work on a risk that does not apply to it. The spike's timing depends on hardware, not on engineering, so the delay has no bound.                                       |
| Run the spike on emulators               | #183 excludes that on purpose: a WebRTC audio path on an emulator proves nothing about a mid-range phone's audio routing, backgrounding or network handover.                        |
| Also build the RN bridge and screens now | That puts `@livekit/react-native` in the lockfile on a build that only compiles, which #183 forbids, and takes the whole team out of Expo Go before anyone knows the pairing holds. |

## Trade-offs accepted

- If #183 ends at fallback (c), part of #184–#186 is discarded. The expected
  cost is small: (c) is third in line, and records and authorization carry over.
- LiveKit joins `docker-compose` and CI before any device has joined a room.
  One more service container per CI run.

## Consequences

- The `Blocked by #183` line on #184 no longer holds. #185 and #186 were
  blocked only through #184.
- #187 is split in practice: its reducers land first, its room bridge later.
- Nothing about the development workflow changes yet. Expo Go keeps working
  until #183 lands a LiveKit module in `apps/mobile`.

## Revisit when

#183 reports. If it reports fallback (c), write the superseding ADR that
ADR-0034 calls for, and name which parts of #184–#186 it retires.
