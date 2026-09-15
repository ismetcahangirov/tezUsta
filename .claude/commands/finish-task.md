---
description: Run the full Definition of Done gate, review the diff honestly, then commit, push, and open the PR
argument-hint: <issue-number>
allowed-tools: Bash, Read, Glob, Grep
---

Finish the work for issue **#$1** against the Definition of Done (CLAUDE.md §8).

**Report results truthfully. If something fails or was not verified, say so —
do not claim success you did not observe (CLAUDE.md §20).**

## 1. Run the gate

```bash
pnpm verify
```

That is `format:check → lint → typecheck → test → build → graph:validate` — the
whole Definition of Done gate in one command, `build` included.

Two things to know before you report the result:

- **`pnpm build` is a no-op today.** No workspace defines a `build` script yet;
  it becomes real when `apps/api` lands. A green `verify` is not evidence that
  anything built.
- **`apps/mobile` runs `jest --passWithNoTests`** and is the only workspace with
  a `test` script. A passing `pnpm test` therefore does not prove tests ran.
  Check the output for the count.

Show me the real output. If anything fails, **stop and fix it** — do not skip a
test, delete a test, or disable a rule to get past it.

## 2. Check the committed project graph is current

```bash
pnpm graph:check
```

This regenerates the graph and fails if the committed output moved. The
generator reads no clock and sorts every collection, so two runs on the same
tree are byte-identical — a non-empty diff now genuinely means the source tree
changed, and the regenerated output must be committed with the change.

CI runs this too, so a stale graph fails the build rather than being quietly
trusted.

## 3. Review the diff, hunk by hunk

```bash
git diff main...HEAD
```

Check for:

- Unrelated changes mixed in
- Debug logging or commented-out code left behind
- **Anything secret** — a key, token, or `.env` value
- Hardcoded design values (colour, spacing, typography)
- Anything the issue did not ask for

Report anything you find rather than quietly fixing it.

## 4. Security pass

If the change touches auth, input handling, uploads, location, or a new endpoint,
run the `security-review` skill checklist and report the result.

## 5. Commit

Conventional Commits, imperative mood, one logical change:

```bash
git add -A
git commit -m "<type>(<scope>): <description>"
```

## 6. Push and open the PR

```bash
git push -u origin HEAD
gh pr create -R ismetcahangirov/tezUsta \
  --title "<type>(<scope>): <description>" \
  --body "..."
```

The PR body must state:

- What changed and **why**
- `Closes #$1`
- **What was verified, and what was not**
- Security and performance considerations
- Any follow-up deliberately left out

## 7. Update the issue

Comment on #$1 with what was done and what was verified. Set `status:review`.

## 8. Report to me

Tell me plainly:

- What passed, with the actual output
- **What you could not verify**
- Anything you deliberately left for a follow-up
- Any decision you need from me
