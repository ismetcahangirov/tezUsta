# ADR-0073 — Becoming a master in the app

- **Status:** **Accepted (entry points by delegation; the copy is the owner's to replace)**
- **Date:** 2026-11-01
- **Decided by:** Project owner, by delegation. Asked where the path should start, the owner answered "necə istəyirsən elə et" (do it however you think best) on 1 November 2026. Both entry points below were chosen on that basis.
- **Context:** Issue #490, found on the 31 October 2026 device check.
- **Builds on:** [ADR-0023](ADR-0023-master-verification-policy.md) (what is collected), [ADR-0024](ADR-0024-presigned-upload-mechanism.md) (the upload path), [ADR-0064](ADR-0064-services-before-approval.md) (a master under review can prepare services), [ADR-0072](ADR-0072-email-one-time-code-sign-in.md) (sign-in grants no role).

## Context

The API has served everything needed to become a master since EPIC 5: `POST /masters` creates the profile and grants the `master` role; `POST /masters/me/documents/presign` and `.../confirm` take the three ADR-0023 photos; `POST /masters/me/verification/submit` sends them for review. No screen called any of them. The app could show `pending_verification` and `changes_requested`, but nobody could reach either state from the phone. On the device check the test master had to be created by hand through the API. Without this, the marketplace has no supply at launch.

Sign-in carries no role (`otp.service.ts`), and `customer` is the app's default role, so every new account landed on the customer name question.

## Decision

1. **Two entry points, one flow.**
   - **A brand-new account** is asked first: "Sifariş vermək istəyirəm" or "Usta kimi işləmək istəyirəm". This is the case of no role grant and no customer profile, and it is the only case. "Order" carries on to the existing name question. "Work" opens the onboarding, so a master is never made to create a customer profile first. The question lives in `CustomerProfileGate`, the place that already asked new accounts their first question.
   - **An existing customer** finds "Usta ol" under Settings → Hesab. It is hidden once the account holds the master grant; from then on the role switch is the way in.
   - Both open `(shared)/become-master`. `(shared)` is the one group an account with no role, or with only `customer`, can reach.
2. **The flow is read from the server at every step**, never from local state, so it reopens where the person left off:
   - **No profile** (`GET /masters/me` answers 403 or 404): name, plus an optional bio. `POST /masters` is followed by one refresh through the shared refresh coordinator and a `signedIn`, because the route guard reads roles from the token and the token in memory predates the grant.
   - **Documents:** the ID card front, the back, and a selfie holding it. Each row shows "Əlavə edilməyib", "Göndərilib", "Təsdiqlənib" or "Yenidən göndərin", with a button to pick or replace the photo. The photo is prepared like every other upload (`preparePhoto`), presigned, `PUT` and confirmed. A confirmed photo replaces the previous live one of its type on the server.
   - **Waiting:** a new profile is already `pending_verification`, and the admin queue lists masters by that status, so once all three documents are confirmed it is in review whether or not anyone taps submit. `submitForReview` answers a `pending_verification` master without moving them. The screen therefore shows "Sənədləriniz yoxlanılır" as soon as the third photo lands, with a button to the master home.
   - **`changes_requested`:** the documents step with a banner. The rejected rows are marked, and "Yoxlamaya göndər" is enabled once nothing rejected is left. Only that submit moves the master back to `pending_verification`.
   - **`active`:** "Siz artıq ustasınız" and a button to the master home. **`rejected` / `suspended`:** a statement and nothing to do, because the appeal path is still open (roadmap).
3. **The master home links back** while the profile is `pending_verification` or `changes_requested`, through a banner with a "Sənədlər" button, so an unfinished onboarding is never more than a tap away.
4. **The photo library only, for now.** The app is built with `cameraPermission: false` (`app.config.js`), and opening the camera needs a new native build and a camera usage string. The screen says a photo can be taken with the phone's camera and picked here. Photos are not cropped: a crop the person gets wrong could cut off the field an admin needs.

## Alternatives considered

- **A role choice only, at first launch.** Rejected: it leaves every existing customer without a way to start working.
- **"Usta ol" in Settings only.** Rejected: a master would have to invent a customer profile first, and the first thing a new master sees would be a question addressed to someone ordering.
- **Keep the person on the documents step until they tap submit, even for a new profile.** Rejected: the profile is already in the admin queue at that point, and the screen would be claiming a step the server does not have.
- **Open the camera in the app.** Deferred, not rejected: it needs a native build, and the library path works today.

## Consequences

- New feature folder `apps/mobile/src/master-onboarding/`, a new route `app/(shared)/become-master.tsx`, and a new tag type, `MasterDocument`.
- `CustomerProfileGate` shows `RoleChoice` to an account with no role. Settings shows "Usta ol". The master home shows `VerificationNotice`.
- **Follow-ups:**
  - camera capture, once a native build is due;
  - showing the admin's reason on a rejected document, if the API exposes it to the master;
  - the appeal path out of `rejected` (owner).
- **Placeholder copy for the owner:** every string in `master-onboarding-copy.ts`.
