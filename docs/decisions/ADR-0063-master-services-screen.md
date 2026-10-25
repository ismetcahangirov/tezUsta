# ADR-0063 — The master's services screen

- **Status:** **Accepted (layout by delegation; the copy is the owner's to replace)**
- **Date:** 2026-10-25
- **Decided by:** Project owner. On 25 October 2026 the owner approved the proposed layout ("ikisini də et, necə məsləhətdisə"): a "Xidmətləri idarə et" control on the Services card of the master's own profile, a "Xidmətlərim" screen, a catalogue pick with a price, and an edit for each row.
- **Context:** EPIC 5 (master profile). No issue: the auto-mode classifier denies `gh issue create` in this repository, so the pull request records the reason.
- **Builds on:** [ADR-0054](ADR-0054-master-profile-and-portfolio-screens.md) (the master's own profile and its Services card), [ADR-0010](ADR-0010-pricing-and-commission.md) (the master sets the price), [ADR-0060](ADR-0060-inspection-price-approval.md) (the price field and its parsing), [ADR-0029](ADR-0029-customer-order-screen.md) (one screen with local steps).
- **Superseded in part by:** [ADR-0064](ADR-0064-services-before-approval.md) — § 2: a master awaiting review (`pending_verification`, `changes_requested`) can reach the screen too.

## Context

The API has served `GET/POST /masters/me/services` and `PATCH/DELETE /masters/me/services/:serviceId` since EPIC 5, but no client called them. A master could not say which services they offer or what they charge. Dispatch offers an order only to a master who actively offers its service (`MastersService.offersActiveService`), so without this screen a newly approved master gets no offers until someone writes their rows for them.

## Decision

1. **The way in is the Services card on the master's own profile.** A secondary "Xidmətləri idarə et" button sits at the card's foot. On their own profile the card is drawn even with no services, with a line saying there are none, because the card is then the only way to add the first one. A customer reading the profile sees no change.
2. **Only an active master reaches it**, as only an active master reaches their profile (ADR-0054). `docs/product/master-flow.md` gives a master waiting on review nothing to do, and this screen does not change that, although the API would accept their rows (`requireOwnProfile` asks only that the profile exists).
3. **One pushed screen, `(master)/services`, with local steps:**
   - **List:** each offered service in a `Card` of `ListRow`s. The row shows the name and, as trailing content, the master's price or "Qiymət baxışdan sonra". A paused service carries a subtitle saying so. A primary "Xidmət əlavə et" button sits under the card; with no services there is an `EmptyState` holding the same button.
   - **Pick:** the catalogue, grouped under its categories' names in catalogue order, without the services already on the list.
   - **Add:** a fixed-price service asks for a price, with the field, parser and error text of the inspection quote (ADR-0060). An inspection-priced service says its price is set on site and asks for nothing. The step's button is "Əlavə et".
   - **Edit:** a fixed-price service's price, prefilled. Then "Müvəqqəti dayandır" or "Yenidən aktiv et", and "Xidməti sil".
   - **Back:** "Geri" and Android's back button step back through these before leaving the screen.
4. **Names and pricing shapes come from the catalogue**, read in the app's locale. The master's rows carry only an id and a price. If the catalogue has retired a service the master still offers, it stays on the list under a name that says so, and the only action offered is removal. The server refuses any other change to it.
5. **A refused write keeps the step on screen** with a danger banner ("Alınmadı. Yenidən cəhd edin."). A completed one returns to the list. The list and the profile redraw from the server: the mutations invalidate `MasterService` and `MasterProfile`.
6. **Removal has no confirmation.** It is undone by adding the service again, and the only thing lost is a price the master typed.

## Alternatives considered

- **Bottom sheets over the list**, as the portfolio's edit and delete use. Rejected: the catalogue pick is a long, grouped list that wants the full screen, and a price field in a sheet has to fight the keyboard. Local steps are the pattern order creation already settled.
- **The way in from Settings or the home header.** Rejected: services are part of the profile the customer reads (ADR-0054 § 3), and the own profile is already the master's preview of that.
- **Letting a master waiting on review set their services early**, so the first offer after approval is not lost to an empty list. It is a product call that the master flow currently answers the other way, so it is left to the owner. Making the change would mean one button in the own-profile empty state.
- **A confirmation before removal.** It could be added in one step if the owner wants it. It was left out for now because it guards nothing that cannot be redone.

## Consequences

- New feature folder `apps/mobile/src/master-services/`. There is a new tag type, `MasterService`, and a new route, `app/(master)/services.tsx`.
- `MasterProfileHeader` takes an optional `servicesAction`, and `OwnProfile` takes `onManageServices`.
- **Placeholder copy for the owner:**
  - every string in `master-services-copy.ts`;
  - `PORTFOLIO_COPY.own.manageServices`;
  - `PORTFOLIO_COPY.own.noServices`.
- Not done here: reordering services, and a master-side reference price from the catalogue. The catalogue's `pricing.amountMinor` is a reference figure, not the master's price (ADR-0010), so it is not prefilled.
