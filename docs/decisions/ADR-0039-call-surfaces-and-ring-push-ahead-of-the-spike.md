# ADR-0039 — Call screens and the ring push do not wait on the mobile spike

- **Status:** Accepted
- **Date:** 2026-09-24
- **Amends:** [ADR-0038](ADR-0038-server-calling-ahead-of-the-mobile-spike.md)
  § Decision 3, for #188 and #189 only. Its rule that nothing from `@livekit/*`
  enters `apps/mobile` until #183 reports **stands unchanged**.
- **Decided by:** the project owner delegated the decisions in EPIC 18 on
  2026-09-24 ("decide professionally, do not ask").
- **Issues:** [#183], [#187], [#188], [#189]

[#183]: https://github.com/ismetcahangirov/tezUsta/issues/183
[#187]: https://github.com/ismetcahangirov/tezUsta/issues/187
[#188]: https://github.com/ismetcahangirov/tezUsta/issues/188
[#189]: https://github.com/ismetcahangirov/tezUsta/issues/189

## Context

ADR-0038 let the server half of calling and #187's pure reducers go ahead of
the two-device spike (#183), and held back three things: #187's room bridge,
the screens in #188 and the wake-up in #189. It filed all three under "uses the
RN SDK".

That is true of the bridge and not of most of the other two. Read issue by
issue:

| Work                                                    | Imports `@livekit/*`? | Survives fallback (a) / (b) | (c) masked PSTN |
| ------------------------------------------------------- | --------------------- | --------------------------- | --------------- |
| #188 screens, copy, end-reason words, Storybook         | no                    | yes                         | ended copy only |
| #188 routes and the call entry point                    | no                    | yes                         | entry point yes |
| #187 microphone-permission hook                         | no                    | yes                         | no              |
| #189 ring push, `GET /calls/:id`, the `calls` channel   | no                    | yes                         | no              |
| #189 push → confirm with the server → incoming screen   | no                    | yes                         | no              |
| #187 room bridge; #188 mute and speaker acting on media | **yes**               | —                           | —               |
| #189 measured wake-up latency on a mid-range Android    | needs a device        | —                           | —               |

The screens are driven by the reducers that are already on `main`; mute and
speaker are two callbacks the bridge will implement. The ring push is server
work plus a notification route. None of it touches the WebRTC module, and none
of it takes the app out of Expo Go.

## Decision

1. **#188 and #189 proceed now, minus what needs media or a device.** The
   screens, their copy, their stories and tests, the routes, the push, the
   server-side ring confirmation and the notification route land ahead of #183.
2. **The microphone-permission hook from #187 lands with them**, on
   `expo-audio` (`57.0.5`, MIT, Expo-versioned, part of Expo Go), because the
   incoming screen asks for the microphone on accept and a permission is not
   something a room bridge should own.
3. **Calling ships dark.** A single constant, `CALLING_ENABLED`, in
   `apps/mobile/src/calls/`, is `false` until the room bridge lands. While it
   is `false` the entry points render nothing, so nobody can place a call that
   would reach `connecting` and stay there; an incoming ring is unreachable in
   practice for the same reason, because no build can start one. The routes,
   the screens and the push path are all exercised by tests with the flag
   forced on.
4. **The ring push is a wake-up, not a ring.** It carries `kind`, `orderId`
   and `callId` and nothing else — no token, no phone number, no name in
   `data`. The device reads `GET /calls/:callId` (party-only) before it shows
   an incoming screen, and shows one only if the server says `RINGING` and
   this account is the callee. The push expires at the provider after the ring
   timeout (`ttl = CALL_RING_TIMEOUT_SECONDS`), so a push that could only
   arrive late is not delivered at all.
5. **A high-priority notification, not a system call screen.** `CallKit` and
   Android's `ConnectionService` are not reachable from Expo's managed workflow
   without a native module of our own, which is a larger decision than this
   Epic's and is not taken here. The ring is a high-importance notification on
   its own Android channel, `calls`, with the platform's default sound and a
   vibration pattern. A custom ringtone is owner art and waits for the owner.
6. **A resolved call's notification is dismissed by the device, not the
   server.** Expo's push service cannot retract a delivered notification. The
   app dismisses any presented notification for a call id the moment it learns
   that call is over — a `call:*` frame, or the server's answer to the
   confirmation read. A phone that learns nothing (the app was killed and never
   reopened) keeps the notification until it is tapped, and the tap then finds
   the call over and opens the order instead. That is a stated limitation, to
   be measured when #183 has devices.

## Alternatives considered

| Option                                       | Why not                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep #188 and #189 behind the spike          | Holds two issues of pure UI and server work on a hardware gate that has no date, for a risk — the WebRTC pairing — that none of that work touches.                 |
| Ship the entry point live without the bridge | Every answered call would sit in `connecting` forever. A visibly broken feature is worse than an absent one.                                                       |
| A runtime feature flag served by the API     | A remote switch for a feature whose missing half is a native module cannot be turned on remotely anyway; the app needs a release either way. A constant is honest. |
| `react-native-callkeep` for a system call UI | A native module with its own RN-compatibility question — the same class of risk #183 exists to retire — for a feature the Epic did not require.                    |
| A silent push to dismiss the ring            | Background delivery of data-only pushes is exactly what Android throttles on the devices this market uses; it cannot be relied on to do the dismissing.            |

## Trade-offs accepted

- Code ships that no user can reach until the bridge lands. It is tested, and
  the flag is one line to flip in the bridge's PR.
- `expo-audio` is added for a permission prompt. It is an Expo SDK module, so
  it moves with the SDK rather than adding a compatibility question of its own.
- A killed app keeps a stale ring notification until it is opened.

## Consequences

- #188 and #189 are split the way #187 was: most lands now, the part that needs
  media or a device lands after #183.
- The bridge's PR flips `CALLING_ENABLED`, wires mute and speaker, and runs the
  manual two-device checks both issues list.
- `NotificationKind` gains `call-incoming`, and the notification categories
  gain `calls`: transactional, not switchable.

## Revisit when

#183 reports. On fallback (c) the ring push and the screens' media controls are
retired with the ring flow; the ended-screen copy and the entry point carry
over.
