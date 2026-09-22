# ADR-0031 — Settings is a tab for the customer and a control for the master

- **Status:** **Accepted**
- **Date:** 2026-09-22
- **Amends:** [`design-system.md`](../design/design-system.md) § 9 and
  [`CLAUDE.md`](../../CLAUDE.md) § 17, where the master's half of "the
  navigation pattern" was still listed as outstanding. This settles how each
  role reaches settings; what else lives at the root of a master's tree stays
  open.
- **Builds on:**
  [ADR-0030](ADR-0030-customer-root-navigation-and-order-list.md), which gave
  the customer a tab bar and deliberately left this out of #160's scope.
- **Decided by:** the project owner, who asked for [#164] to be worked on
  knowing it was filed blocked on this decision — the third time that
  delegation has been made (see ADR-0029, ADR-0030). CLAUDE.md § 17's "stop and
  ask" rule is answered for these entry points and nothing else.

[#164]: https://github.com/ismetcahangirov/tezUsta/issues/164

## Context

`app/(shared)/settings.tsx` existed, was guarded, rendered correctly — and **no
screen in the app linked to it.** A search for every navigation call in
`apps/mobile` found exactly one link into `(shared)`: none.

What was stranded behind it is not decoration: the notification preferences of
#147 (the only way to turn a category off), the saved addresses of #90 — which
settings links _out_ to, so the address screen was reachable from a screen that
was not — the appearance switch, the role switch, and both sign-out controls.
A user could not sign out of this app.

ADR-0030 named the gap and declined to fix it in passing, because `(shared)`
belongs to both roles and only one of them had somewhere to put a tab.

## Decision

### 1. The customer gets a third tab

`Tənzimləmələr`, with `SettingsIcon`, beside the catalogue and the order list.

An account area is a tab in every app this market's customers already use, and
what is behind it only grows — payment methods (EPIC 12), a profile, support.
A gear in the catalogue's header would have been a smaller change and would
have made the one screen holding sign-out the hardest of the three to find.

The tab's label is the screen's heading, word for word. A tab that says one
thing and opens a screen titled another makes a person check whether they
arrived where they meant to.

### 2. The master gets a control on their home screen

An `IconButton` in the title row of `(master)/index.tsx`, pushing
`/(shared)/settings`.

The master's root is a single stack with one screen (ADR-0030 § 2). A two-tab
bar whose second tab is settings would be a bar about settings, and a bar is
not what a master's home needs before it has a job list to put in one.

**When EPIC 8/9 gives the master tree a bar, settings becomes its third tab and
this control goes away.** That is not a migration to dread: it is deleting six
lines from one screen and adding a `Tabs.Screen`.

### 3. The two roles reach it differently, on purpose

They share the screen; they do not have to share the route into it. Making the
customer's entry a pushed screen for symmetry would hide the account area
behind a header icon for the role that has most to do there, and making the
master's a tab would invent a bar for a tree with one destination in it.

### 4. One implementation, two routes

The screen moved out of the route file into `src/settings/Settings.tsx`.
`(customer)/(tabs)/settings.tsx` and `(shared)/settings.tsx` both render it.

This is a constraint of the router, not a preference: an Expo Router
`Tabs.Screen` names a route **inside its own directory**, so a screen that is a
tab for one role and a pushed screen for another cannot be a single route. What
matters is that it is a single _implementation_ — the role-dependent part of
the screen (saved addresses are a customer concept) is already a branch inside
it and stays one.

`(shared)` keeps the route rather than the screen moving under `(master)/`,
because the group is exactly what it says — both roles may visit it, and
`route-guard.ts` already encodes that. A master-only copy would make the guard's
answer a lie the day a customer deep-links into it.

### 5. The screen scrolls now

It did not. On a phone holding a role switch, an appearance switch, every
notification category the server serves, and two sign-out buttons, the last of
those is below the fold — and with a tab bar under it, further below still. A
sign-out control nobody can scroll to is not a control, so this is part of the
entry point rather than an unrelated fix riding along with it.

## Consequences

- A user can sign out. A customer can turn a notification category off. A
  master can switch to their customer role. None of that was reachable from a
  screen before.
- `src/settings/` exists, with the screen and its copy. The strings moved into
  `settings-copy.ts` with it, matching every other feature module — they were
  literals in a route file, which stopped being defensible once a tab label and
  a heading had to agree.
- Two routes render one screen. The duplication is a path, not a behaviour.

## What this does not decide

Where role switching _belongs_ — it is a navigation-level affordance in every
app that has one, and it sits on this screen because this is the screen both
roles can reach. The master's root beyond this control. The words on the screen,
which remain a first draft. Whether "sign out everywhere" gets the confirmation
step it visibly lacks.

## Alternatives considered

| Alternative                                  | Why not                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A gear in the catalogue's header, both roles | Symmetrical, and hides the account area behind an icon for the role with most to do there; makes sign-out the hardest thing to find                  |
| Move the screen under each role's tree       | Removes the duplicate route, at the cost of deleting the `(shared)` group from the route guard and its tests — a bigger change for a smaller problem |
| A drawer for the master                      | A navigation pattern nobody asked for, for one destination                                                                                           |
| Wait for the master's tab bar (EPIC 8/9)     | Leaves both roles unable to sign out for the length of two epics                                                                                     |
