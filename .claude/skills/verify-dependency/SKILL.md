---
name: verify-dependency
description: Use BEFORE adding, upgrading, or pinning any npm package in TezUsta — verifies real compatibility against registry metadata and official docs instead of assuming. Triggers on "add package", "install", "upgrade", "bump version", "is X compatible", or any dependency change.
---

# Verify a dependency before adding or upgrading it

TezUsta pins three packages **behind** their newest release on purpose. Each
would install cleanly and then cause damage. This skill is the procedure that
found those, and it must be run before any dependency change.

**The rule this exists to enforce: a satisfied peer range is not evidence of
support.**

## Step 1 — What is actually "latest"?

```bash
curl -s https://registry.npmjs.org/-/package/<pkg>/dist-tags
```

Read the **tags**, not just a version number. A package can publish `58.0.0` under
`preview` while `latest` is still `57.x` — that is exactly the Expo situation.
Installing a `preview` build into production is not an upgrade.

## Step 2 — Read the real peer and engine constraints

```bash
curl -s https://registry.npmjs.org/<pkg>/<version> | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('version:',j.version);console.log('peer:',JSON.stringify(j.peerDependencies,null,1));console.log('engines:',JSON.stringify(j.engines))})"
```

Check against the repository's pins:

| Constraint   | Value                                          |
| ------------ | ---------------------------------------------- |
| Node         | 24 (`.nvmrc`)                                  |
| TypeScript   | **6.0.3** — `typescript-eslint` peers `<6.1.0` |
| Expo SDK     | **57**                                         |
| React Native | 0.86.x (chosen by the SDK)                     |
| React        | 19.2.3 (chosen by the SDK)                     |
| Tailwind     | **3.4.17** — NativeWind v4 requires Tailwind 3 |

A conflict here is decisive. `madge` was rejected from this repository on exactly
this check (`peer: typescript ^5.4.4`).

## Step 3 — Read the official documentation too

**This is the step people skip, and it is where the real traps are.**

The peer range says what the manifest permits. The documentation says what the
maintainer actually tested. They diverge:

> `nativewind@4.2.6` declares `peerDependencies: { tailwindcss: ">3.3.0" }`.
> Tailwind 4.3.3 satisfies it, so `pnpm install` succeeds with no warning.
> NativeWind's installation guide specifies `tailwindcss@^3.4.17`, because v4
> targets the Tailwind 3 engine.

Find the package's own installation or compatibility page and read the version it
names.

## Step 4 — When docs and package disagree, inspect the package

```bash
cd "$(mktemp -d)" && npm pack <pkg>@<version> >/dev/null 2>&1 && tar xzf *.tgz
ls package/            # then read the actual .d.ts
```

Drizzle's docs page implied PostGIS needed a custom type. The shipped package had
native `geometry()` with SRID and GiST support. **The artifact wins.**

## Step 5 — Ask the policy questions

From `docs/engineering/dependency-policy.md`:

- Is it necessary, or would twenty lines of our own code do?
- Is it actively maintained?
- Is there a security advisory? (`pnpm audit`)
- Does something already in the tree do this?
- What does it cost in bundle size on a mid-range Android device?
- Is there a first-party Expo or Nest alternative?

Popularity is not a criterion.

## Step 6 — Install correctly

```bash
# Expo-managed packages — ALWAYS. Consults Expo's compatibility service.
npx expo install expo-location

# Everything else — exact version, no range, for tooling
pnpm add -D --save-exact <pkg>@<version>
```

**Never `pnpm add` an Expo-managed package.** It installs `latest`, which may
belong to a different SDK.

## Step 7 — Verify and record

```bash
pnpm install
pnpm verify
```

If the change alters a pinned version from `ADR-0002`, write a **new ADR that
supersedes it**. Do not edit the accepted ADR.

## Pinned — do not upgrade without a superseding ADR

| Package       | Pinned | Newest     | Gate                                                                             |
| ------------- | ------ | ---------- | -------------------------------------------------------------------------------- |
| `typescript`  | 6.0.3  | 7.0.2      | `typescript-eslint` peers `<6.1.0`; TS 7 silently disables type-aware lint rules |
| `expo`        | 57.x   | 58 preview | 58 is not on `latest`                                                            |
| `tailwindcss` | 3.4.17 | 4.3.3      | NativeWind v4 requires Tailwind 3; v5 is "not intended for production use"       |
