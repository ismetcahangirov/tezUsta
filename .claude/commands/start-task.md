---
description: Start work on a GitHub issue — sync main, create the branch, load context, and report the blast radius
argument-hint: <issue-number>
allowed-tools: Bash, Read, Glob, Grep
---

Start work on issue **#$1** following the workflow in CLAUDE.md §7.

Do these in order and report what you find. Stop and tell me if any step fails.

## 1. Read the issue

```bash
gh issue view $1 -R ismetcahangirov/tezUsta --json number,title,body,labels,assignees
```

If it carries `needs-design-decision`, **stop** and tell me which decision is
outstanding — do not invent it (CLAUDE.md §17).

If it is `status:blocked`, tell me what it is blocked by before continuing.

## 2. Sync and branch

```bash
git fetch origin
git checkout main
git pull origin main
git status --porcelain          # must be empty
```

If the tree is dirty, stop and show me what is uncommitted.

Then create the branch, named from the issue's type label and title:

```bash
git checkout -b <type>/$1-<short-kebab-description>
```

Types: `feat` `fix` `refactor` `test` `docs` `chore` `perf` `security`.

## 3. Load the relevant context

Read whichever apply to this issue:

- `CLAUDE.md`
- The `docs/architecture/` page for the area
- Any ADR the issue references
- `docs/engineering/security.md` if it touches auth, input, uploads, or PII

## 4. Report the blast radius

For each existing file the issue will likely change:

```bash
node tools/project-graph/query.mjs <file>
```

## 5. Tell me the plan

Before writing code, report:

- What you will change, and where
- What depends on it (from step 4)
- Which tests you will write **first**
- Anything in the issue that is ambiguous or blocked
- Any dependency you would need to add (run the `verify-dependency` skill first)

Then wait for my go-ahead.
