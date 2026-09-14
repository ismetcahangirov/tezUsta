# ADR-0012 — Storybook on React Native Web + Vite as the component workshop

- **Status:** **Accepted**
- **Date:** 2026-09-14

## Context

With the design system settled ([ADR-0011](ADR-0011-design-system.md)), the
components it describes need somewhere to be built and reviewed in isolation —
every variant, every state, in both themes — before they are wired into screens.

The project owner reviews the visual design and is not going to run a simulator
to do it.

## Decision

**Storybook 10.6 with `@storybook/react-native-web-vite`**, hosted inside
`apps/mobile`, run with `pnpm --filter mobile storybook`.

Rejected: `@storybook/react-native` (the on-device runtime).

## Why

Version metadata, read from the npm registry and the Expo SDK API rather than
from memory (CLAUDE.md §9):

| Package                                   | Declares                                                       | Against Expo SDK 57         |
| ----------------------------------------- | -------------------------------------------------------------- | --------------------------- |
| `@storybook/react-native@10.6.0`          | `react-native-safe-area-context` **exactly `5.8.0`**           | SDK 57 pins `~5.7.0` ❌     |
| `@storybook/react-native@10.6.0`          | `@gorhom/bottom-sheet >=4`, `react-native-gesture-handler >=2` | Two deps for the tool alone |
| `@storybook/react-native-web-vite@10.6.0` | `react-native-web ^0.19.12 \|\| ^0.20 \|\| ^0.21`              | SDK 57 pins `~0.21.0` ✅    |
| `@storybook/react-native-web-vite@10.6.0` | `react >=16.8` (19 ok), `react-native >=0.74.5`, `vite ^5–^8`  | 19.2.3 / 0.86.3 / 8.3.0 ✅  |

The on-device runtime is **not installable** against this SDK without forcing a
version Expo does not ship. That is disqualifying on its own; the extra
dependencies pulled in purely for Storybook's own UI (CLAUDE.md §10) settle it.

The web renderer is also the better fit for the job: it opens in a browser, so
the owner can review components on a laptop, and it builds in CI.

**NativeWind support is documented, not hoped for.** Storybook's own page for
this framework shows the configuration:

```ts
framework: {
  name: '@storybook/react-native-web-vite',
  options: { pluginReactOptions: { jsxImportSource: 'nativewind' } },
}
```

Verified end to end: the built stylesheet contains
`--color-bg:240 240 240` and `--color-bg:17 17 17`, and `.font-bold` resolves to
`font-family: Anybody_700Bold`. Both themes render.

## Alternatives considered

| Option                              | Why not                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `@storybook/react-native` on device | Peer conflict with SDK 57's `react-native-safe-area-context`; needs two extra deps     |
| Pin `@storybook/react-native@10.4`  | Looser peers, but freezes the tool and still ships the extra dependencies              |
| A "kitchen sink" screen in the app  | No dependency cost; no isolation, no controls, no per-variant review, and it ships     |
| A separate `packages/ui` workspace  | Would violate CLAUDE.md §2 — no second consumer exists until the admin panel (EPIC 13) |

## Trade-offs accepted

- **Stories render under `react-native-web`, not on a device.** Layout is close
  but not identical; anything platform-specific still needs a real device.
- **Storybook is a large devDependency tree.** It never reaches the app bundle.
- **Fonts are registered twice** — `useFonts` on the device, an injected
  `@font-face` in the preview. Both read the same files from
  `@expo-google-fonts/anybody`, so they cannot drift.

## Consequences

- `apps/mobile/.storybook/` holds the config; stories live beside their
  components as `*.stories.tsx`.
- `.dependency-cruiser.cjs` exempts stories and `.storybook/` from
  `not-to-dev-dep` — a story is tooling, not shipped code.
- **`packages/typescript-config/base.json` had to stop reaching outside its own
  package.** Its `extends: "../../tsconfig.base.json"` resolved through the
  workspace symlink to a path that does not exist, and Rolldown (Vite 8) failed
  on every file. `tsc` tolerated it because it resolves the real path first.
  The shared options now live in the package and the repo-root
  `tsconfig.base.json` is a thin alias.
- **The token file is `design-tokens.json`, not `tokens.json`.** Next to
  `tokens.ts` that name makes `./tokens` ambiguous, and Vite resolved it to the
  JSON — which Jest did not, so the failure only appeared in the browser.

## Revisit when

- A component's behaviour cannot be trusted under `react-native-web` and needs
  on-device review often enough to justify the second runtime.
- `@storybook/react-native` relaxes its exact peer pins.
