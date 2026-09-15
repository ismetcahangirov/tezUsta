# Git workflow

## Branching

**`main` is never committed to directly.** It is the integration branch and the
source of every deployment.

```
main
 ├── feat/123-order-creation
 ├── fix/145-double-accept-race
 └── docs/architecture-realtime
```

### Branch names

`type/short-description`, lowercase kebab-case, with the issue number when one
exists:

```
feat/123-order-creation
fix/145-double-accept-race
perf/167-nearby-master-query
security/171-otp-rate-limit
refactor/api-error-handling
test/master-matching
docs/system-architecture
chore/project-foundation
```

Allowed types: `feat` `fix` `refactor` `test` `docs` `chore` `perf` `security`.

**Forbidden:** `test`, `dev`, `fix`, `branch1`, `new-feature`, `mybranch`
([CLAUDE.md §5](../../CLAUDE.md) holds the list). Each is either a bare type with
no description, or a name that says nothing — GitHub's default `patch-1` is the
same failure and is equally unacceptable. A branch name is a message to whoever
reads the history later.

Nothing rejects a badly named branch; this is a convention a reviewer enforces,
not a hook.

### Before starting any branch

```bash
git fetch origin
git checkout main
git pull origin main
git status          # must be clean
git checkout -b feat/123-order-creation
```

Branching from a stale `main` produces a merge conflict that looks like a
logic error.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[body]

[footer]
```

```
feat(order): add order creation endpoint with address validation
fix(matching): prevent double assignment under concurrent accept
perf(location): add GiST index for nearby-master radius query
security(auth): rate-limit OTP requests per phone number
test(order): cover invalid state machine transitions
docs(architecture): document realtime location budget
chore(repo): initialize engineering foundation
refactor(api): extract error mapping into a filter
```

Rules:

- Imperative mood — "add", not "added" or "adds".
- Lowercase description, no trailing period.
- Scope is the module or area: `order`, `auth`, `matching`, `location`, `repo`.
- Under ~72 characters in the subject.
- **One logical change per commit.** No "misc fixes".

There is no commitlint and no husky hook in this repository: a malformed commit
message is caught in review or not at all. Write it correctly the first time —
after a squash merge it is the permanent history entry for the whole change.

The body explains **why**, when that is not obvious:

```
fix(matching): prevent double assignment under concurrent accept

Two masters accepting simultaneously both read status=SEARCHING and both
wrote, leaving one order assigned twice. The status check now lives in the
UPDATE's WHERE clause, so the database evaluates it atomically with the write.

Closes #145
```

### Never commit

- `.env`, keys, tokens, credentials ([`security.md`](security.md))
- Commented-out code
- `node_modules/`, build output
- Unrelated formatting churn mixed into a feature — it hides the real change

## Pull requests

### Before opening

```bash
pnpm verify        # format:check + lint + typecheck + test + build + graph:validate
pnpm graph:check   # regenerates the graph and fails if the committed one moved
git diff main...HEAD   # review every hunk
```

`pnpm build` is part of `verify` and is a **no-op today** — no workspace defines
a `build` script yet. It becomes a real gate when `apps/api` lands; until then a
green `verify` says nothing about a build.

**Review your own diff first.** Most review comments are things the author would
have caught by reading it once.

### PR description

Use `.github/pull_request_template.md`. It must state:

- What changed and **why**
- `Closes #<issue>`
- What was **verified**, and what was not
- Security and performance considerations
- Any follow-up work deliberately left out

**Honesty about what was not verified is required, not optional**
([CLAUDE.md §20](../../CLAUDE.md)). "Tests pass" when they were not run is the
single most damaging thing to claim.

### Merging

- CI must be green. `graph:validate` and `graph:check` are required gates.
- **Squash merge** into `main` — one issue, one commit, a readable history.
- Delete the branch after merge.
- The issue closes from the merge, not before.

## Keeping a branch current

Prefer rebase for a branch only you have:

```bash
git fetch origin
git rebase origin/main
```

Use merge if the branch is shared — rebasing a shared branch rewrites history
other people have pulled.

**Never force-push a branch someone else may have pulled.** Use
`--force-with-lease`, never bare `--force`, on your own branches.

## Recovering from mistakes

| Situation                       | Action                                                                    |
| ------------------------------- | ------------------------------------------------------------------------- |
| Committed to `main` locally     | `git branch feat/x && git reset --hard origin/main`                       |
| Wrong commit message (unpushed) | `git commit --amend`                                                      |
| Committed a secret              | **Rotate the secret first.** Removing it from history does not un-leak it |
| Need to undo a pushed commit    | `git revert` — never rewrite shared history                               |

On a public repository, a pushed secret must be assumed compromised from the
moment of the push.

## Hygiene

- Keep branches short-lived. A long-running branch diverges and merges badly.
- Push at least daily — unpushed work is unbacked-up work.
- One branch per issue. A branch doing two things cannot be reviewed properly.
