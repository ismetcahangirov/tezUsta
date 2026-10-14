# ADR-0045 — The master's public profile and photo portfolio

- **Status:** Accepted. Video is deferred (§ 7). The public media domain and the
  final content rules are the owner's to supply.
- **Date:** 14 October 2026
- **Decided by:** The owner, 14 October 2026, who took every recommendation put
  to them on #302: the profile is seen only from an order, photos only at
  launch, the proposed limits, post-moderation with 30 days of evidence, the
  proposed profile fields, and no originals kept. Engineering settled the
  formats, delivery and pipeline (CLAUDE.md §9).
- **Context:** issue #302; EPIC 19 (#301)
- **Builds on:** [ADR-0005](ADR-0005-object-storage.md) and
  [ADR-0024](ADR-0024-presigned-upload-mechanism.md) (storage, which this adds a
  second bucket to and supersedes nothing in),
  [ADR-0025](ADR-0025-deferred-work-on-bullmq.md) (the queue),
  [ADR-0009](ADR-0009-dispatch-model.md) (the customer does not choose a
  master), [ADR-0042](ADR-0042-review-policy.md) (ratings, and removal with a
  reason), [ADR-0043](ADR-0043-admin-panel-policy.md) (the audit log)

## Context

A customer meets their master as a name, a star average and a dot on a map.
Nothing shows what that master's work looks like. Masters have the answer on
their phones: photos of finished jobs. EPIC 19 gives them somewhere to put them.

`GET /masters/:id` is owner-only today, and its comment calls a public profile
"a decision for a later Epic". This is that decision. The visual design of the
profile, grid and viewer is not part of it (CLAUDE.md §17); it belongs to #303.

## Decision

### 1. What the public profile shows

| Shown                                         | Never shown                                         |
| --------------------------------------------- | --------------------------------------------------- |
| Display name, bio and avatar                  | Phone number                                        |
| Rating: the average and the count (ADR-0042)  | Location, live or past                              |
| Active services, each with the master's price | Verification documents and their status             |
| The portfolio, newest post first              | Anything that ties a post to an order or a customer |
| —                                             | Subscription state                                  |

The issue's list of exclusions named `commission_debt_minor`. That column was
dropped with commission itself (ADR-0046, migration 0037), so there is nothing
left to exclude.

Revealed review comments stay off the profile. ADR-0042 § 6 keeps public
comments out of the product until they have their own moderation.

### 2. Who may read it, and from where

- **The customer of an order this master is assigned to**, while the master is
  on it and for the review window (`REVIEW_WINDOW_HOURS`) after the order ends.
  The window lets the customer look while they decide on a review.
- **The master themselves**, as a preview of what a customer sees.
- **Nobody else**, including other masters and any customer without such an
  order. They get the same 404 a missing master gets, so a master id cannot be
  probed.
- **Only while the master is `active`** and not deleted. A suspended or deleted
  master's profile and media stop being served at once (§ 6 for the files).
- **No list, search or enumeration endpoint.** Dispatch is a parallel broadcast
  where the first accept wins (ADR-0009). The customer does not choose a master,
  so a directory would serve a choice the product does not offer. A directory is
  a change to ADR-0009 and would be its own Epic.

**The entry points** are the master's name on the customer's order screen, once
a master is assigned, and a preview on the master's own profile screen.

**Alternative rejected:** any authenticated user reads any active master's
profile by id. That allows sharing a profile, but it hands every master's work
and face to anyone with an account, for a choice the customer cannot act on.

### 3. Who may post, and a post's shape

- **Only an `active` master** creates, edits or deletes a post, and only their
  own. A suspended or deleted master's posts stop being served and are not
  deleted; a reinstated master's posts come back.
- **A post** is 1–10 photos, an optional caption of at most 500 characters, and
  an optional tag naming one of the master's own active services.
- **The caption and the tag are editable; the photos are not.** Changing the
  photos means deleting the post and posting again. That keeps a post's media
  immutable, which is what lets its URLs be cached forever (§ 5).
- **Order:** newest first, by publication time.

### 4. Limits

Each limit is an environment variable with a default, so that changing one is a
configuration change and not a supersession of this ADR.

| Limit                                | Env var                            | Default    |
| ------------------------------------ | ---------------------------------- | ---------- |
| Posts per master                     | `PORTFOLIO_MAX_POSTS_PER_MASTER`   | 60         |
| Photos per post                      | `PORTFOLIO_MAX_ITEMS_PER_POST`     | 10         |
| Caption length                       | `PORTFOLIO_CAPTION_MAX_CHARS`      | 500        |
| Raw image upload                     | `PORTFOLIO_IMAGE_MAX_BYTES`        | 15 MiB     |
| Input pixels the decoder will accept | `PORTFOLIO_IMAGE_MAX_INPUT_PIXELS` | 24 000 000 |
| Days a removed post's media is kept  | `PORTFOLIO_REMOVED_RETENTION_DAYS` | 30         |

The client already sends a JPEG with its long edge at most 2560 px (#319), so a
real photo arrives near a megabyte. The 15 MiB and 24 MP caps bound what a
hostile client can make the server decode, not what a phone sends.

The video limits the issue proposed (duration ≤ 60 s, raw upload ≤ 100 MiB,
dimensions ≤ 4096 px) are set when video is (§ 7).

### 5. Images: renditions, and how they are delivered

**Formats.** The server re-encodes every photo it publishes; nothing the client
produced is served to a customer. Each photo becomes two renditions:

| Rendition | Long edge | Format | Quality |
| --------- | --------- | ------ | ------- |
| `thumb`   | 480 px    | WebP   | 75      |
| `full`    | 1440 px   | WebP   | 80      |

- Resized to fit inside the box, never enlarged.
- Oriented from the EXIF tag first, then written upright with no tag.
- Converted to sRGB.
- **Every metadata block is stripped**: EXIF (with any GPS), XMP and IPTC.
  Location is PII (CLAUDE.md §11), and phone photos carry it. A test proves it
  with a geotagged fixture.
- The tool is `sharp` (0.35 at the time of writing, Node ≥ 20.9), on a
  dedicated `media` BullMQ queue at concurrency 1, never on the request path.
  In its terms: `autoOrient()`, then
  `resize({ width, height, fit: 'inside', withoutEnlargement: true })`, then
  `webp({ quality })`. It is never given `keepMetadata()` or `withMetadata()`:
  by default `sharp` converts to sRGB and strips all metadata, which is the
  behaviour this section requires. `limitInputPixels` is set from
  `PORTFOLIO_IMAGE_MAX_INPUT_PIXELS`, because its own default (about 268 MP) is
  far above any phone photo.
- Prebuilt `sharp` cannot decode HEIC: HEVC-compressed HEIF needs a libvips
  built with libheif, libde265 and x265. The client converts first (#319), and
  the server refuses HEIC bytes rather than guess.

**AVIF is deferred.** It is smaller than WebP at the same quality. But on
Android, `expo-image` decodes AVIF through libavif, in software and on every
API level, not through the platform's decoder. Nobody has measured what that
costs on a mid-range phone scrolling a grid, and it must be measured first.
WebP decodes natively on Android and through Apple's codec on iOS.

**Originals are not kept.** The raw upload is deleted once its renditions are
written. Originals are five to twenty times the size and carry GPS. The cost:
the media cannot be re-encoded from source later. A future format change
re-encodes from the 1440 px rendition, or asks the master to post again.

**Delivery.**

- Renditions go to a **second, public R2 bucket on a custom domain**
  (`PORTFOLIO_PUBLIC_BASE_URL`; the domain is the owner's to choose and create,
  #304). Raw uploads stay in the existing private bucket. ADR-0024's argument
  rests on that bucket being private, so it stays private, and nothing in
  ADR-0024 changes.
- **Keys are random and immutable:** `portfolio/<random>/<rendition>.webp`.
  They carry no master id and no post id, so a URL says nothing about who made
  it, and two posts by one master cannot be linked by their URLs.
- Objects are written with
  `Cache-Control: public, max-age=31536000, immutable`. Cloudflare's cache
  honours an object's `Cache-Control` on a custom domain and caches `.webp` by
  default. A rendition never changes under its key, so it can be cached for a
  year and never needs purging except on deletion. `expo-image` keys its disk
  cache on the URL; a presigned URL would change on every read and defeat it.
  R2 does not presign on a custom domain anyway.
- The bucket's `r2.dev` address stays off. Cloudflare rate-limits it and
  documents it as for development only.
- The API returns the URLs only inside a profile response, to a caller who has
  just passed § 2. A URL someone saved keeps working until the post is deleted
  and the CDN purged, which is accepted: the photos were shown to that person
  anyway.

### 6. Deletion and moderation

**A master deletes a post.** The row is hidden at once, so the next profile
read no longer shows it. A job then deletes every rendition and purges each URL
from the CDN cache. A URL someone already saved keeps working until that purge,
which is an accepted trade-off.

**Moderation is after publication.**

- A post publishes as soon as processing completes. Nobody reviews it first.
- An admin can remove a post with a **mandatory reason**. The removal is
  audited as `portfolio.remove`, the way `review.remove` is (ADR-0042). The
  permission is `portfolio.moderate`, held by moderator and super_admin, like
  `reviews.moderate`.
- **A removed post's media is kept for 30 days as evidence**
  (`PORTFOLIO_REMOVED_RETENTION_DAYS`), and is not public meanwhile. Its
  renditions move from the public bucket to the private one, and the public
  URLs are deleted and purged at once. An admin reads them in that window
  through short-lived presigned URLs. A sweep then deletes them. A master's own
  deletion is not evidence and keeps nothing.
- **How the move happens is #312's to prove.** R2 implements `CopyObject`, and
  its release notes imply a copy between two buckets in one account works, but
  no page says so outright. If it does not, the server downloads the rendition
  and uploads it to the private bucket; either way it is one rendition per
  photo, not the original.

**Pre-moderation is rejected.** It puts an admin between every master and their
portfolio, at a staff size that does not exist yet. The portfolio's audience is
small by design (§ 2: one customer, from one order), which limits what a bad
post can reach before it is removed.

**Content rules (interim).** The final text is the owner's and a lawyer's. Until
then, the rules shown to a master are:

- no people who have not agreed to be photographed;
- no house numbers, street signs or anything that locates a customer's home;
- no documents.

These rules are given to masters, and an admin removes a post that breaks them.
No code enforces them.

### 7. Video is deferred

The owner chose photos only at launch. Video costs a transcoding pipeline
(`ffmpeg` in the runtime image), more storage and traffic, and the client-side
compression spike (#316), for a feature photos already mostly cover.

When video is added, a new ADR settles it. The direction researched for this
one is recorded so that work does not restart from nothing: H.264 + AAC-LC in a
progressive MP4 with `+faststart`, long edge ≤ 1280 px at 30 fps, CRF about 24
with a maxrate of about 2.5 Mb/s, every global **and** per-stream metadata block
stripped, and a WebP poster frame. HLS was set aside as a cost with no benefit
at 60 seconds; HEVC and AV1 were set aside in favour of the codec every phone
plays. That ADR verifies these choices against the platforms' documentation
before it accepts them.

## Consequences

- **A second bucket, on a custom domain.** The owner creates it and its domain
  (#304). Until then every issue proceeds against the stub storage provider.
- **CPU in the API process.** `sharp` runs in the in-process worker
  (ADR-0025) at concurrency 1. A burst of posts delays the next one's
  processing, not any request. Moving the `media` queue to a separate worker is
  the same additive step ADR-0025 describes, and is due when a measurement
  (#317) shows processing competing with requests.
- **A new dependency, `sharp`,** goes through
  `docs/engineering/dependency-policy.md` when #305 installs it.
- **EPIC 19's video issues wait:** #306 (video pipeline) and #316 (the
  compression spike), and the video parts of #313, #314 and #317.
- **The customer's order screen gains an entry to the master's profile** (#315).
  Its design is #303's.

## Sources

Checked on 14 October 2026:

- sharp: [output](https://sharp.pixelplumbing.com/api-output) (metadata and
  sRGB defaults, `webp` options),
  [operations](https://sharp.pixelplumbing.com/api-operation) (`autoOrient`,
  added in 0.34.0), [constructor](https://sharp.pixelplumbing.com/api-constructor)
  (`limitInputPixels`), [resize](https://sharp.pixelplumbing.com/api-resize),
  [install](https://sharp.pixelplumbing.com/install) (prebuilt formats, no
  HEIC).
- Cloudflare R2: [public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
  (custom domains, `r2.dev`),
  [R2 and the cache](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/),
  [purge by URL](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/),
  [S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
  (`CopyObject`), [object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/),
  [pricing](https://developers.cloudflare.com/r2/pricing/) (no egress charge).
- Expo: [`expo-image`](https://docs.expo.dev/versions/latest/sdk/image/)
  (formats), and its Android build, which decodes AVIF through Glide's libavif
  integration.
- Android: [supported media formats](https://developer.android.com/media/platform/supported-formats).

## Revisit when

- The owner wants video (§ 7), or a directory of masters (a change to
  ADR-0009).
- AVIF has been measured on a mid-range Android phone (§ 5).
- The owner and a lawyer supply the final content rules (§ 6).
