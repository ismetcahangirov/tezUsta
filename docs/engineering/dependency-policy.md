# Dependency policy

Every dependency is code we did not write, ship to users, and must keep secure.
The default answer to "should we add this?" is **no**, until the case is made.

## Before adding a package

1. **Is it necessary?** Would twenty lines of our own code do it? A one-function
   dependency is rarely worth the supply-chain surface.
2. **Is it maintained?** Recent releases, issues triaged, more than one
   maintainer. An unmaintained package is a vulnerability with a delay.
3. **Is it compatible?** Check the **real** `peerDependencies` and `engines`
   against our pinned Node 24, TypeScript 6, Expo 57, React Native 0.86:

   ```bash
   curl -s https://registry.npmjs.org/<pkg>/<version> | jq '{peerDependencies, engines}'
   ```

4. **Security?** `pnpm audit`. Review the transitive tree, not just the package.
5. **Does something already in the tree do this?**
6. **What does it cost?** Bundle size matters on a mid-range Android device, and
   install/build time matters in CI.
7. **Is there an official alternative?** Prefer first-party Expo or Nest packages
   over third-party equivalents.

**Popularity is not a criterion.** Download counts measure adoption, not fitness
for this stack.

## A satisfied peer range is not evidence of support

This is the lesson from [ADR-0002](../decisions/ADR-0002-toolchain-version-pinning.md)
and it is the most important rule on this page.

`nativewind@4.2.6` declares `peerDependencies: { tailwindcss: ">3.3.0" }`.
Tailwind 4.3.3 satisfies it, so `pnpm install` succeeds — and the pairing is
unsupported, because NativeWind v4 targets the Tailwind 3 engine. The install
gives no warning.

**Check the documentation as well as the metadata.** A loosely-declared range
admits major versions the author never tested.

## When the docs and the package disagree, the package wins

Drizzle's documentation page implied PostGIS needed a custom type. Inspecting the
published tarball showed native `geometry()` support with SRID and GiST indexing
([ADR-0003](../decisions/ADR-0003-database-and-geo.md)).

```bash
npm pack <pkg>@<version> && tar xzf <pkg>-<version>.tgz   # then read it
```

Verify against the artifact when the answer matters.

## Version pinning

| Kind                                                              | Policy                                         |
| ----------------------------------------------------------------- | ---------------------------------------------- |
| Tooling (TypeScript, ESLint, Prettier, turbo, dependency-cruiser) | **Exact.** No range.                           |
| Runtime dependencies                                              | Exact, upgraded deliberately                   |
| Expo-managed packages                                             | **`npx expo install`**, never `pnpm add`       |
| `react`, `react-native`                                           | Chosen **by the Expo SDK**, never set directly |

`npx expo install` consults Expo's compatibility service and installs the version
that matches the SDK. `pnpm add expo-location` installs `latest`, which may
belong to a different SDK.

## Currently pinned against upgrade

Do not "helpfully" upgrade these. Each has a documented reason
([ADR-0002](../decisions/ADR-0002-toolchain-version-pinning.md)):

| Package       | Pinned | Newest     | Gate                              |
| ------------- | ------ | ---------- | --------------------------------- |
| `typescript`  | 6.0.3  | 7.0.2      | `typescript-eslint` peer `<6.1.0` |
| `expo`        | 57.x   | 58 preview | 58 is not on `latest`             |
| `tailwindcss` | 3.4.17 | 4.3.3      | NativeWind v4 requires Tailwind 3 |

Upgrading any of them requires re-running the compatibility check and writing an
ADR that supersedes ADR-0002.

## Upgrading

- Upgrade **one significant dependency per PR**. A failure in a batched upgrade
  cannot be attributed.
- Read the changelog, not just the version number.
- Run `pnpm verify` and exercise the affected area.
- Major versions get their own PR and a real review.
- Security patches take priority and can move faster — but still verified.

## Removing

When a feature is removed, remove its dependencies. Orphaned packages are
maintenance and attack surface for nothing.

```bash
node tools/project-graph/query.mjs <file>   # confirm nothing still imports it
pnpm why <package>                          # confirm nothing depends on it
```

## Forbidden

- Adding a package to avoid writing a simple function
- Adding a package without checking its peers against our pins
- Installing `latest` for an Expo-managed package
- Committing a lockfile change that was not reviewed
- Adding a dependency with a known unpatched critical advisory
- Upgrading a pinned package without a superseding ADR

## Lockfile

`pnpm-lock.yaml` is committed and reviewed. A change to it in a PR that did not
intend a dependency change is a red flag worth asking about.

CI installs with a frozen lockfile, so a dependency cannot drift between local
and CI.
