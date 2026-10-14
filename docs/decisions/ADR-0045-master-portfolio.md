# ADR-0045 — The master's public profile and photo portfolio

- **Status:** Accepted (video, media domain, content rules pending)
- **Date:** 2026-10-14
- **Decided by:** The owner, 14 October 2026, who took every recommendation put
  to them on #302: the profile is seen only from an order, photos only at
  launch, the proposed limits, post-moderation with 30 days of evidence, the
  proposed profile fields, and no originals kept. Engineering settled the
  formats, delivery and pipeline (CLAUDE.md §9).
- **Amends:** [ADR-0005](ADR-0005-object-storage.md) (narrows where its
  "private bucket" rule applies, § 5),
  [ADR-0042](ADR-0042-review-policy.md) § 6 (one more reader of a master's
  rating, § 2), [ADR-0043](ADR-0043-admin-panel-policy.md) § 1 (a new
  permission, § 6). It supersedes nothing in
  [ADR-0024](ADR-0024-presigned-upload-mechanism.md).
- **Context:** issue #302; EPIC 19 (#301)

## Context

A customer meets their master as a name, a star average and a dot on a map.
Nothing shows what that master's work looks like. Masters have the answer on
their phones: photos of finished jobs. EPIC 19 gives them somewhere to put them.

`GET /masters/:id` is owner-only today, and its comment calls a public profile
"a decision for a later Epic". This is that decision. The visual design of the
profile, grid and viewer is not part of it (CLAUDE.md §17); it belongs to #303.

**Pending, and named:** video (§ 7), the public media domain (§ 5, #304), and
the final content rules (§ 6). Everything else is settled.

## Decision

### 1. What the public profile shows

| Shown                                         | Never shown                                         |
| --------------------------------------------- | --------------------------------------------------- |
| Display name, bio and avatar (§ 8)            | Phone number                                        |
| Rating: the average and the count (ADR-0042)  | Location, live or past                              |
| Active services, each with the master's price | Verification documents and their status             |
| The portfolio, newest post first              | Anything that ties a post to an order or a customer |
| —                                             | Subscription state                                  |

This is the whole list. A field not in it, such as a post count or a
"member since" date, is a new decision for the owner.

The issue's list of exclusions named `commission_debt_minor`. That column was
dropped with commission itself (ADR-0046, migration 0037), so there is nothing
left to exclude.

Revealed review comments stay off the profile. ADR-0042 § 6 keeps public
comments out of the product until they have their own moderation.

### 2. Who may read it, and from where

A caller may read a master's profile when one of these holds, checked on every
request:

- **They are the customer of an order this master is on:** the order's
  `master_id` is this master and its status is `ACCEPTED`,
  `MASTER_ON_THE_WAY`, `MASTER_ARRIVED` or `IN_PROGRESS`.
- **They are the customer of an order this master completed,** within
  `REVIEW_WINDOW_HOURS` of its `COMPLETED` row in `order_status_history`. That
  is ADR-0042 § 2's window, measured the same way, so the customer can look
  while they decide on a review.
- **They are the master themselves**, as a preview of what a customer sees.

An order cancelled after accept, or sent back out by a re-dispatch, ends the
access at that moment: that master is no longer on it and never completed it.

**Only while the master can be shown:** `masters.verification_status` is
`active`, `masters.deleted_at` is null, and the master's account is not
suspended (`users.status`, ADR-0050). A master suspended either way, or
deleted, is not shown.

**Nobody else**, including other masters, gets the profile. They get the same
404 a missing master gets, so a master id cannot be probed.

**No list, search or enumeration endpoint.** Dispatch is a parallel broadcast
where the first accept wins (ADR-0009). The customer does not choose a master,
so a directory would serve a choice the product does not offer. A directory is
a change to ADR-0009 and would be its own Epic.

**The entry points** are the master on the customer's order screen, once a
master is assigned, and the master's own preview.

**This amends ADR-0042 § 6.** Its reader table lets "the customer on an
accepted order" see the master's rating. The profile also shows it to the
customer of a completed order inside the review window.

### 3. Who may post, and a post's shape

- **Only a master who can be shown (§ 2)** creates, edits or deletes a post,
  and only their own.
- **A post** is 1–10 photos, an optional caption of at most 500 characters, and
  an optional tag naming one of the master's own active services.
- **Only the caption is editable.** The photos and the tag are fixed. Changing
  them means deleting the post and posting again. That keeps a post's media
  immutable, which is what lets its URLs be cached forever (§ 5).
- **A tagged service the master later stops offering:** the tag is not shown
  while the service is inactive, and is shown again if it comes back.
- **Order:** newest first, by publication time.

### 4. Limits

Each limit is an environment variable with a default, so that changing one is a
configuration change and not a supersession of this ADR. The names are the
ones the implementing issues use.

| Limit                                | Env var                            | Default    |
| ------------------------------------ | ---------------------------------- | ---------- |
| Posts per master                     | `PORTFOLIO_MAX_POSTS`              | 60         |
| Photos per post                      | `PORTFOLIO_MAX_ITEMS_PER_POST`     | 10         |
| Caption length                       | `PORTFOLIO_CAPTION_MAX_CHARS`      | 500        |
| Raw image upload (post or avatar)    | `PORTFOLIO_IMAGE_MAX_BYTES`        | 15 MiB     |
| Input pixels the decoder will accept | `MEDIA_MAX_INPUT_PIXELS`           | 24 000 000 |
| Days a removed post's media is kept  | `PORTFOLIO_REMOVED_RETENTION_DAYS` | 30         |

The client already sends a JPEG with its long edge at most 2560 px (about
4.9 MP, #319). The 15 MiB and 24 MP caps bound what a hostile client can make
the server decode, not what the app sends.

The video limits the issue proposed (duration ≤ 60 s, raw upload ≤ 100 MiB,
dimensions ≤ 4096 px) are set when video is (§ 7).

### 5. Images: renditions, and how they are delivered

**Formats.** The server re-encodes every photo it publishes; nothing the client
produced is served to a customer. Each portfolio photo becomes two renditions:

| Rendition | Long edge | Format | Quality |
| --------- | --------- | ------ | ------- |
| `thumb`   | 480 px    | WebP   | 75      |
| `display` | 1440 px   | WebP   | 80      |

- Resized to fit inside the box, never enlarged.
- Oriented from the EXIF tag first, then written upright with no tag.
- Converted to sRGB.
- **Every metadata block is stripped**: EXIF (with any GPS), XMP and IPTC.
  Location is PII (CLAUDE.md §11), and phone photos carry it. A test proves it
  with a geotagged fixture.
- **The tool is `sharp`** (0.35 at the time of writing, Node ≥ 20.9). It runs
  in `infra/media/` on a dedicated `media` BullMQ queue at concurrency 1, never
  on the request path. In its terms: `autoOrient()`, then
  `resize({ width, height, fit: 'inside', withoutEnlargement: true })`, then
  `webp({ quality })`. It is never given `keepMetadata()` or `withMetadata()`:
  by default `sharp` converts to sRGB and strips all metadata, which is what
  this section requires. `limitInputPixels` comes from `MEDIA_MAX_INPUT_PIXELS`,
  because `sharp`'s own default (about 268 MP) is far above anything the app
  sends.
- **HEIC is refused.** Prebuilt `sharp` cannot decode it: HEVC-compressed HEIF
  needs a libvips built with libheif, libde265 and x265. The client converts
  first (#319), and the server refuses HEIC bytes rather than guess.

**AVIF is deferred.** It is smaller than WebP at the same quality. But on
Android, `expo-image` decodes AVIF through libavif, in software and on every
API level, not through the platform's decoder. Nobody has measured what that
costs on a mid-range phone scrolling a grid, and it must be measured first.
WebP decodes natively on Android and through Apple's codec on iOS.

**Originals are not kept.** The raw upload is deleted once its renditions are
written. Originals are five to twenty times the size and carry GPS. The cost:
the media cannot be re-encoded from source later. A future format change
re-encodes from the `display` rendition, or asks the master to post again.

**Delivery.**

- Renditions go to a **second, public R2 bucket on a custom domain**
  (`S3_PUBLIC_MEDIA_BUCKET`, served at `MEDIA_PUBLIC_BASE_URL`; the domain is
  the owner's to choose and create, #304). Raw uploads stay in the existing
  private bucket. ADR-0024's argument rests on that bucket being private, so it
  stays private, and nothing in ADR-0024 changes.
- **Keys are random and immutable:** `portfolio/<random>/<rendition>.webp`, and
  `avatars/<random>/<rendition>.webp` for § 8. They carry no master id and no
  post id, so a URL says nothing about who made it, and two posts by one master
  cannot be linked by their URLs.
- Objects are written with
  `Cache-Control: public, max-age=31536000, immutable`. Cloudflare's cache
  honours an object's `Cache-Control` on a custom domain and caches `.webp` by
  default. A rendition never changes under its key, so it can be cached for a
  year and never needs purging except on deletion. `expo-image` keys its disk
  cache on the URL; a presigned URL would change on every read and defeat it.
  R2 does not presign on a custom domain anyway.
- The bucket's `r2.dev` address stays off. Cloudflare rate-limits it and
  documents it as for development only.
- **URLs are handed out only in a response to a caller allowed to see them:** a
  profile read (§ 2), the master's own posts and avatar, and the admin views
  (§ 6).
- **A URL is a capability, not an access check.** Whoever holds one can fetch
  it until the object is deleted and the CDN purged. A device or browser that
  cached it may keep showing it for up to a year whatever the purge does. This
  is accepted: the photo was shown to that person already. Because of it, a
  master's photos must be fit to be seen by anyone who ever saw them (§ 6's
  content rules).

**This narrows ADR-0005.** ADR-0005 treats a photo of a customer's home as PII
and keeps it in a private bucket behind presigned GETs. That still holds for
every photo a customer or a conversation uploads. A portfolio photo is
different in kind: the master chooses to publish it, after the job, under
content rules that keep the home unidentifiable. Whether a master also needs
the homeowner's consent to publish a photo taken in their home is a question
for the owner and a lawyer (§ 6), not one this ADR answers.

### 6. Deletion, suspension and moderation

**A master deletes a post.** The row is hidden at once, so the next profile
read no longer shows it. A job then deletes every rendition and purges each URL
from the CDN cache. Nothing is kept: a master's own deletion is not evidence.

**A master is suspended** (verification or account, § 2). The profile and its
URLs stop being handed out at once. The objects are kept, because a suspension
can be lifted and the posts come back with it. A URL already handed out keeps
working, as § 5 accepts; the keys are random, so no one can find one they were
not given.

**A master deletes their account** (`DELETE /masters/me`). Every post and the
avatar are deleted as a master's own deletion is: rows hidden at once,
renditions deleted and the CDN purged by the sweep. A master who later creates
a profile again starts with an empty portfolio.

**Moderation is after publication.**

- A post publishes as soon as processing completes. Nobody reviews it first.
- An admin can remove a post with a **mandatory reason**. The removal is
  audited as `portfolio_post.remove`, an entity and a verb as `review.remove`
  is. The permission is `portfolio.moderate`, held by moderator and
  super_admin, like `reviews.moderate`. **This adds a permission to ADR-0043
  § 1's role table.**
- **A removed post's media is kept for 30 days as evidence**
  (`PORTFOLIO_REMOVED_RETENTION_DAYS`), and is not public meanwhile. Its
  renditions move from the public bucket to the private one, and the public
  objects are deleted and purged at once. An admin reads them in that window
  through short-lived presigned URLs, as every private object is read. A sweep
  then deletes the renditions. The post's row, with its caption, the reason and
  who removed it, is kept like a removed review, because the audit row points
  at it.
- **How the move happens is #312's to prove**, at the moment of removal. R2
  implements `CopyObject`, and its release notes imply a copy between two
  buckets in one account works, but no page says so outright. If it does not,
  the server downloads the rendition and uploads it to the private bucket.
  Either way it is one rendition per photo, not the original. The 30-day sweep
  is #311's.

**Pre-moderation is rejected.** It puts an admin between every master and their
portfolio, at a staff size that does not exist yet. The portfolio's audience is
small by design (§ 2: one customer, from one order), which limits what a bad
post can reach before it is removed.

**Content rules (interim), for the owner and a lawyer.** The final text, and
where and how a master is shown it, are the owner's. The interim list is:

- no people who have not agreed to be photographed;
- no house numbers, street signs or anything that locates a customer's home;
- no documents;
- open question: whether the homeowner's consent is needed at all (§ 5).

An admin removes a post that breaks them. No code enforces them.

### 7. Video is deferred

The owner chose photos only at launch. Video costs a transcoding pipeline
(`ffmpeg` in the runtime image), more storage and traffic, and the client-side
compression spike (#316), for a feature photos already mostly cover. Until a
new ADR settles video, the server accepts images only: no video upload, kind,
key, duration or player is built.

The direction researched for this ADR is recorded so that work does not
restart from nothing: H.264 + AAC-LC in a progressive MP4 with `+faststart`,
long edge ≤ 1280 px at 30 fps, CRF about 24 with a maxrate of about 2.5 Mb/s,
every global **and** per-stream metadata block stripped, and a WebP poster
frame. HLS was set aside as a cost with no benefit at 60 seconds; HEVC and AV1
were set aside in favour of the codec every phone plays. That ADR verifies
these choices against the platforms' documentation before it accepts them.

### 8. The avatar

- **Renditions:** a square centre crop (`fit: 'cover'`) at 128 px and 512 px,
  WebP, metadata stripped, through the same `media` queue as § 5.
- **Limits:** the same raw size and input pixel caps as a post photo (§ 4).
- **Where:** the public bucket, under `avatars/<random>/`, with the same cache
  rules as § 5.
- **Replacing or removing it:** the new renditions are written first and the
  keys swap in one update, so the profile never shows the fallback in between.
  The old renditions are then deleted and purged. Nothing is kept.
- **Moderation:** an admin can remove an avatar with a mandatory reason, under
  `portfolio.moderate`, audited as `master_avatar.remove`. A removed avatar is
  deleted at once and not kept as evidence: it is one photo of the master
  themselves, and the reason in the audit row records why it went.

## Why

- **Seen only from an order (§ 2):** the customer meets a master because
  dispatch assigned them, and the profile answers the question that customer
  has at that moment: is this person any good at this? Wider reach serves a
  choice the product does not offer (ADR-0009) and widens what a bad post can
  reach.
- **Server-made renditions (§ 5):** the server is the authority on what is
  published. Re-encoding every byte is what strips GPS reliably and caps size
  whatever the client did.
- **A second, public bucket (§ 5):** the private bucket's safety argument
  (ADR-0024) depends on nothing in it being public. Public renditions with
  immutable keys are what make a year of caching, and `expo-image`'s disk
  cache, work.
- **Post-moderation with evidence (§ 6):** removal must be possible and
  provable, but a review queue in front of every post needs staff that do not
  exist.

The technical claims were checked against the sources at the end.

## Alternatives considered

| Option                                                    | Why not                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any authenticated user reads any active master's profile  | Hands every master's work and face to anyone with an account, for a choice the customer cannot act on (ADR-0009). Allows sharing, which is not a goal yet     |
| A public prefix inside the existing private bucket        | One misconfigured rule would expose problem photos and documents. ADR-0024's safety argument is that the bucket holds nothing public                          |
| Presigned GETs on the private bucket for portfolio photos | A URL that changes on every read defeats `expo-image`'s URL-keyed cache and the CDN. R2 cannot presign on a custom domain                                     |
| Serve JPEG renditions                                     | Larger than WebP at the same quality. Every target platform decodes WebP natively or through the OS codec                                                     |
| Serve AVIF renditions                                     | Smaller still, but decoded in software on Android through libavif, which is unmeasured on a mid-range phone                                                   |
| Cloudflare Images or another hosted transform service     | A second paid vendor and a per-image price, for what `sharp` does in-process. It also moves metadata stripping, a privacy control, out of code the repo tests |
| Keep the originals                                        | Five to twenty times the storage, and they carry GPS. The gain is re-encoding from source later                                                               |
| Pre-moderation                                            | An admin between every master and their portfolio, at a staff size that does not exist                                                                        |
| Delete a removed post's media at once                     | Nothing left to show if the master disputes the removal or the post was part of a complaint                                                                   |
| Run `sharp` in a separate worker process now              | No hosting provider or second deployment unit exists yet (ADR-0025). Moving it later is an additive step                                                      |

## Trade-offs accepted

- **A URL outlives its post** on devices that cached it, for up to a year
  (§ 5). Purging the CDN cannot reach a phone's disk cache.
- **No re-encoding from source** (§ 5): a future format starts from the
  `display` rendition or from a new post.
- **CPU in the API process.** `sharp` runs in the in-process worker
  (ADR-0025) at concurrency 1. A burst of posts delays the next one's
  processing, not any request. Moving the `media` queue to a separate worker is
  the additive step ADR-0025 describes, due when #317 measures processing
  competing with requests.
- **No video at launch** (§ 7).

## Consequences

- **The implementing issues follow this ADR where they differ from it.** Before
  each is built, it is brought in line:
  - #307, #308 and #310: images only, with no `video` kind, key, duration or
    MP4 upload;
  - #310: visibility as § 2, not "any authenticated role", and only the fields
    in § 1 (no post count or "member since");
  - #312: removed media read through presigned URLs from the private bucket
    (§ 6), and the cross-bucket move proven there; avatar removal (§ 8);
  - #311: the account-deletion and 30-day evidence sweeps (§ 6);
  - #306 and #316 wait for video, as do the video parts of #313, #314 and #317.
- **A second bucket, on a custom domain.** The owner creates it and its domain
  (#304). Until then every issue proceeds against the stub storage provider.
- **A new dependency, `sharp`,** goes through
  `docs/engineering/dependency-policy.md` when #305 installs it.
- **The customer's order screen gains an entry to the master's profile** (#315).
  Its design is #303's.

## Revisit when

- The owner wants video (§ 7), or a directory of masters (a change to
  ADR-0009).
- AVIF has been measured on a mid-range Android phone (§ 5).
- The owner and a lawyer supply the final content rules, including the
  homeowner-consent question (§ 6).

## Sources

Checked on 14 October 2026:

- sharp: [output](https://sharp.pixelplumbing.com/api-output) (metadata and
  sRGB defaults, `webp` options),
  [operations](https://sharp.pixelplumbing.com/api-operation) (`autoOrient`,
  added in 0.34.0),
  [constructor](https://sharp.pixelplumbing.com/api-constructor)
  (`limitInputPixels`), [resize](https://sharp.pixelplumbing.com/api-resize),
  [install](https://sharp.pixelplumbing.com/install) (prebuilt formats, no
  HEIC).
- Cloudflare R2:
  [public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
  (custom domains, `r2.dev`),
  [R2 and the cache](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/),
  [purge by URL](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/),
  [S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
  (`CopyObject`),
  [object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/),
  [pricing](https://developers.cloudflare.com/r2/pricing/) (no egress charge).
- Expo: [`expo-image`](https://docs.expo.dev/versions/latest/sdk/image/)
  (formats), and its Android build, which decodes AVIF through Glide's libavif
  integration.
- Android:
  [supported media formats](https://developer.android.com/media/platform/supported-formats).
