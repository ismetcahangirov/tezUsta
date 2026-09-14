# ADR-0002 — Toolchain version pinning: TypeScript 6, Expo SDK 57, Tailwind 3

- **Status:** Accepted
- **Date:** 2026-09-14
- **Supersedes:** —
- **Superseded by:** —

## Context

Three packages in this stack have a newer published release than the version we
install. In each case installing the newest version **succeeds** — no install
error, no peer warning that stops the build — and then causes damage that is
discovered much later.

This ADR records those pins so that a future session does not "helpfully"
upgrade them.

## Decision

| Package       | Pinned      | Newest published               | Gate                                 |
| ------------- | ----------- | ------------------------------ | ------------------------------------ |
| `typescript`  | **6.0.3**   | `7.0.2` (`latest`)             | `typescript-eslint` peer range       |
| `expo`        | **57.0.22** | `58.0.0-preview.0` (`preview`) | dist-tag is not `latest`             |
| `tailwindcss` | **3.4.17**  | `4.3.3` (`latest`)             | NativeWind v4 documented requirement |

## Why

### TypeScript 6.0.3, not 7.0.2

Verified against registry metadata on 2026-09-14:

```
typescript-eslint@8.70.0        peer: typescript ">=4.8.4 <6.1.0"
typescript-eslint@8.70.1-alpha.0 peer: typescript ">=4.8.4 <6.1.0"
@nestjs/schematics@12.0.1       peer: typescript ">=6.0.0"
```

NestJS 12 requires **≥ 6.0**. typescript-eslint supports **< 6.1**. The only
version satisfying both is **6.0.x**. No typescript-eslint release — including
the canary channel — admits TypeScript 7.

TypeScript 7 is the Go-native compiler port. Installing it does not fail; it
causes typescript-eslint to disable its type-aware rules. Those are exactly the
rules that catch unhandled promise rejections in request handlers and BullMQ
workers — `no-floating-promises`, `no-misused-promises`, the `no-unsafe-*`
family. Losing them silently is worse than not having a linter, because the
configuration still claims they are on.

### Expo SDK 57, not 58

`expo@58.0.0-preview.0` is published under the **`preview`** dist-tag. The
`latest` tag resolves to `57.0.22`, and `docs.expo.dev/versions/latest`
documents SDK 57.

React Native and React versions follow from the SDK — SDK 57 pairs with RN 0.86.x
and React 19.2.3 — and must not be chosen independently. Expo's own modules are
versioned in lockstep (`expo-router@57.x`, `expo-location@57.x`); mixing a 58.x
module into a 57 app is unsupported.

### Tailwind CSS 3.4.17, not 4.3.3

This is the most dangerous pin, because nothing warns you.

`nativewind@4.2.6` declares `peerDependencies: { "tailwindcss": ">3.3.0" }`.
Tailwind `4.3.3` satisfies that range, so installation is clean. But NativeWind's
official installation guide specifies `tailwindcss@^3.4.17`: NativeWind v4
targets the Tailwind 3 engine, and Tailwind 4 replaced the configuration and
compilation model wholesale.

NativeWind v5 does support the new model. Its own documentation says it is a
pre-release and **"not intended for production use."**

## The general rule this establishes

**A satisfied peer range is not evidence of support.**

`pnpm install` checks declared ranges. It cannot check whether a maintainer has
actually tested the combination, and a loosely-declared range (`>3.3.0`) admits
major versions the author never intended. Before pinning any version, check the
package's _documentation_ as well as its metadata — and when the two disagree,
inspect the shipped package.

## Alternatives considered

| Option                                   | Why not                                                                                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install latest everywhere                | Disables type-aware linting, ships a preview SDK, and pairs NativeWind with an engine it does not support.                                                                                |
| Drop typescript-eslint, use TypeScript 7 | Trades the entire type-aware lint layer for a compiler speed improvement we do not currently need.                                                                                        |
| Use NativeWind v5 preview for Tailwind 4 | Its documentation explicitly rules out production use.                                                                                                                                    |
| Use StyleSheet instead of NativeWind     | Viable, and removes the Tailwind constraint entirely — but the styling approach is bound up with the design system, which the user owns (CLAUDE.md §17). Not ours to decide unilaterally. |

## Trade-offs accepted

- We forgo TypeScript 7's compile-speed improvements.
- We forgo Tailwind 4's engine and config improvements.
- We are one SDK behind the newest Expo preview, so some new APIs are unavailable.

All three are accepted deliberately in exchange for a toolchain whose parts are
actually tested together.

## How to re-verify before any upgrade

```bash
curl -s https://registry.npmjs.org/-/package/typescript-eslint/dist-tags
curl -s https://registry.npmjs.org/typescript-eslint/<version> | jq .peerDependencies
curl -s https://registry.npmjs.org/-/package/expo/dist-tags
```

Upgrading any of these three requires a new ADR superseding this one, plus a
green `pnpm verify`.

## Revisit when

- typescript-eslint publishes a release whose peer range admits TypeScript 7.
- Expo SDK 58 moves to the `latest` dist-tag.
- NativeWind v5 reaches a stable release.
