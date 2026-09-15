---
description: Start work on a GitHub issue — sync main, create the branch, load context, and report the blast radius
argument-hint: <issue-number>
allowed-tools: Bash, Read, Glob, Grep
---

Start work on issue **#$1** following the workflow in CLAUDE.md §7.

Do these in order and report what you find. Stop and tell me if any step fails.

**The order is deliberate.** Context before the issue, the issue before the
branch, and research before the plan — a branch created before you know which
ADR governs the area is a branch you will rename.

## 1. Read the rules and the area context — first, not last

- `CLAUDE.md` in full.
- The `docs/architecture/` page for the area the issue names.
- Every ADR that area depends on, and any ADR the issue references.
  `docs/decisions/README.md` indexes them.
- `docs/engineering/security.md` if it touches auth, input, uploads, or PII.

An issue's title and labels are enough to tell you which of these apply:

```bash
gh issue view $1 -R ismetcahangirov/tezUsta --json title,labels
```

## 2. Read the issue in full

```bash
gh issue view $1 -R ismetcahangirov/tezUsta --json number,title,body,labels,assignees
```

If it carries `needs-design-decision`, **stop** and tell me which decision is
outstanding — do not invent it (CLAUDE.md §17).

If it is `status:blocked`, tell me what it is blocked by before continuing.

Read it against step 1: an issue that contradicts an accepted ADR is a question
for me, not something to resolve in code.

## 3. Sync and verify the tree is clean

```bash
git fetch origin
git checkout main
git pull origin main
git status --porcelain          # must be empty
```

If the tree is dirty, stop and show me what is uncommitted.

## 4. Create the branch

Named from the issue's type label and title:

```bash
git checkout -b <type>/$1-<short-kebab-description>
```

Types: `feat` `fix` `refactor` `test` `docs` `chore` `perf` `security`.

Never `test`, `dev`, `fix`, `branch1`, `new-feature`, `mybranch`, or anything
else that is a bare type or says nothing. Nothing rejects a bad branch name, so
this one is on you.

## 5. Report the blast radius

For each existing file the issue will likely change:

```bash
node tools/project-graph/query.mjs <file>
```

## 6. Research anything uncertain — against primary sources

CLAUDE.md §9: do not act on assumption when a technical decision matters. If the
issue involves a library, a version, an API, or a pattern you are not certain
of, resolve it now, from official documentation, the official repository, the
spec, or the shipped package itself — not from memory or a blog post.

Use the `researcher` agent for anything that needs evidence, and the
`verify-dependency` skill before any package would be added or upgraded.

Report what you looked up and what it said. If something could not be verified,
say so rather than presenting a guess as a finding.

## 7. Tell me the plan

Before writing code, report:

- What you will change, and where
- What depends on it (from step 5)
- What you researched, and what it settled (from step 6)
- Which tests you will write **first**
- Anything in the issue that is ambiguous or blocked
- Any dependency you would need to add

Then wait for my go-ahead.
