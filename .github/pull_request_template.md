## What changed

<!-- What this does, and why. Not a restatement of the diff. -->

Closes #

## What was verified

<!-- Tick only what you actually ran and observed. Honesty here is required. -->

- [ ] `pnpm verify` passes (format:check, lint, typecheck, test, build, graph:validate)
- [ ] `pnpm graph:check` passes — the committed project graph is current
- [ ] Tested manually — describe how:

<!-- Two caveats worth stating rather than glossing: `pnpm build` is part of
     `verify` and is a no-op until apps/api exists, and apps/mobile runs
     `jest --passWithNoTests`, so a green run can mean nothing ran. If your
     change relies on either, say so below. -->

## What was NOT verified

<!-- Required if anything above is unticked, or if something could not be
     checked in this environment. "Nothing" is a valid answer. -->

## Security

- [ ] New inputs validated server-side
- [ ] Authorization checked server-side, including ownership
- [ ] No sensitive data in logs or error responses
- [ ] New abusable endpoints rate limited
- [ ] No secrets committed. No new `EXPO_PUBLIC_` value grants server authority
      or billing power — platform-restricted client map keys, scoped to the Maps
      SDK, are the one documented exception; `GOOGLE_MAPS_SERVER_API_KEY` never
      carries the prefix
- [ ] Every new environment variable is in `.env.example` and the environment
      schema
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
