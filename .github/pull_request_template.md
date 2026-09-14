## What changed

<!-- What this does, and why. Not a restatement of the diff. -->

Closes #

## What was verified

<!-- Tick only what you actually ran and observed. Honesty here is required. -->

- [ ] `pnpm verify` passes (format, lint, typecheck, test, graph:validate)
- [ ] `pnpm build` passes where applicable
- [ ] Project graph regenerated (`pnpm graph`) if module structure changed
- [ ] Tested manually — describe how:

## What was NOT verified

<!-- Required if anything above is unticked, or if something could not be
     checked in this environment. "Nothing" is a valid answer. -->

## Security

- [ ] New inputs validated server-side
- [ ] Authorization checked server-side, including ownership
- [ ] No sensitive data in logs or error responses
- [ ] New abusable endpoints rate limited
- [ ] No secrets committed; nothing secret behind `EXPO_PUBLIC_`
- [ ] N/A — this change touches none of the above

## Performance

- [ ] New foreign keys and hot-path queries are indexed
- [ ] No N+1 query introduced
- [ ] No uncontrolled polling or unbudgeted location updates
- [ ] N/A

## Design decisions

- [ ] No visual or product decision was invented (CLAUDE.md §17)
- [ ] Blocked on a design decision — labelled `needs-design-decision`

## Follow-up left out

<!-- Anything deliberately deferred, and where it is tracked. -->
