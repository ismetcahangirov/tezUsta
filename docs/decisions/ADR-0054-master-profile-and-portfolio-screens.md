# ADR-0054 — The master profile, portfolio grid, photo viewer and post editor

- **Status:** Accepted (copy and empty-state art pending)
- **Date:** 2026-10-14
- **Decided by:** The owner delegated the design of #303 on 14 October 2026
  ("sən özün necə istəyirsənsə elə et"). Engineering laid it out inside the
  design system (ADR-0011, ADR-0048), as ADR-0035 and ADR-0036 were, and
  showed the owner a six-screen mockup, which they accepted as recommended
  ("necə məsləhətdirsə"). The copy and the empty-state art stay the owner's.
- **Amends:** [ADR-0036](ADR-0036-master-work-surface.md): the master's home
  gains a second pushed destination, their own profile (§ 4).
- **Context:** issue #303; EPIC 19 (#301)
- **Builds on:** [ADR-0045](ADR-0045-master-portfolio.md) (what the profile
  shows and who sees it; photos only), [ADR-0011](ADR-0011-design-system.md)
  and its tokens, [ADR-0036](ADR-0036-master-work-surface.md) (the master's
  stack), [ADR-0041](ADR-0041-call-surface-fixed-appearance.md) (a full-screen
  surface with a fixed dark appearance)

## Context

ADR-0045 settled what the profile shows and who may see it. CLAUDE.md §17 makes
how it looks the owner's, and the owner delegated it. The design system settles
colour, type, spacing, radius and the component inventory, but has no profile
header, media grid or full-screen viewer. This ADR arranges those from existing
components and tokens, and adds three components: `MediaGrid`, `MediaViewer`
and `PostEditor`'s photo strip, all built from tokens.

Video is deferred (ADR-0045 § 7), so nothing here plays, marks or controls one.

## Decision

### 1. The profile screen

One pushed screen, the same for both readers:
`(customer)/order/[id]/master` for the customer and `(master)/profile` for the
master. Top to bottom:

1. **The header row:** the screen title and "Geri", as every pushed screen has.
2. **The identity block**, on the page and not in a card:
   - the avatar at `avatar-lg` (64), a circle;
   - beside it, the display name in `h1` and, under it, the rating as the
     existing `PartyRatingLine` (one star and the average, then the count);
   - under both, the bio in `body`, at most four lines, with "Daha çox" to
     show the rest. No bio: nothing, not a placeholder.
3. **Services:** a `Card` titled "Xidmətlər" (`h2`), one `ListRow` per active
   service: the service name, and the master's price on the right in
   `body-strong`. No services: the card is not drawn.
4. **The portfolio:** "İşlər" (`h2`), then the grid (§ 2), or the empty state
   (§ 6).

On their own profile the master also sees, under the identity block, a primary
`Button` "Yeni paylaşım" (§ 5), and their avatar is pressable (§ 7).

### 2. The grid

- **Three columns of square tiles**, a `space.1` (4 px) gap, no radius, edge to
  edge inside the screen's padding. Square tiles crop the centre of each photo
  (`contentFit="cover"`); the viewer shows the whole photo.
- **The tile shows the post's first photo**, at the `thumb` rendition.
- **A post with more than one photo** carries a small stack mark in its top
  right corner: the Lucide `Copy` icon at `icon.size.sm`, `on-inverse` on an
  `overlay` circle at reduced opacity, so it reads on any photo. It is not the
  accent (§ 3 of the design system forbids accent icons).
- **Newest first**, as ADR-0045 § 3 orders posts.
- Tapping a tile opens the viewer on that post.

### 3. The photo viewer

- **Full screen, over everything**, with the call screen's fixed appearance
  (ADR-0041): `#111` behind the photo in both themes, `#fff` type and icons.
  A photo is looked at against black whatever the theme.
- **One post at a time.** Its photos page horizontally with a swipe; the photo
  is shown whole (`contentFit="contain"`) at the `display` rendition.
- **Top:** a close `IconButton` (X) on the left and, when the post has more
  than one photo, "2 / 5" on the right in `caption`. Android's back button
  closes it too.
- **Under the photo**, when there is more than one: a row of small dots, the
  current one `#fff` and the rest `#5c5c5c`.
- **Bottom:** the caption in `body`, then the service tag as a `Badge` and the
  date in `caption`. A long caption scrolls in its own area, never over the
  photo's centre.
- **Not in it:** pinch to zoom, swiping between posts, and swiping down to
  close. Each is motion, which stays the owner's (CLAUDE.md §17); the close
  button and the back button are enough to ship.

### 4. The entry point on the order screen

Once a master is assigned, the customer's order screen shows a `Card` with one
`ListRow` under the status card and above "Mesajlar": the master's avatar at
`avatar-sm`, their name, "Profilə bax" under it in `text-muted`, and a chevron.
Tapping it opens § 1. It is the same row shape as "Mesajlar", so the screen
gains no new kind of element. It is not drawn before a master is assigned, nor
after ADR-0045 § 2's window closes.

The master reaches their own profile from their home: their avatar at
`avatar-md` (44, the touch target) sits in the header row beside the settings
button, labelled "Profilim".

### 5. The post editor

A pushed screen, `(master)/post/new`, opened from "Yeni paylaşım".

- **Choosing photos:** "Şəkil əlavə et (3 / 10)", a secondary button that
  counts against the post's limit (`PORTFOLIO_MAX_ITEMS_PER_POST`), opens the
  system picker with multiple selection. Chosen
  photos appear as a three-column strip of square tiles, in the order chosen.
  **No reordering**: the order chosen is the order shown. Reordering is a drag
  gesture, which is motion; a master who wants another order removes a photo
  and adds it again.
- **Each tile** has a remove `IconButton` (X) in its corner, and:
  - while it uploads, a `ProgressBar` along its bottom edge;
  - if it failed, a `danger` outline and a retry `IconButton` in its centre.
- **Caption:** a multi-line `TextField`, "Təsvir (istəyə bağlı)", with a
  counter to `PORTFOLIO_CAPTION_MAX_CHARS`.
- **Service tag:** "Xidmət (istəyə bağlı)", the master's own active services as
  rows with a check, as the report form chooses a reason (ADR-0053). Tapping
  the chosen row again clears it.
- **One button, "Paylaş",** at the foot. It is enabled once every photo has
  uploaded and at least one is left, and a `footnote` under it says so while
  it is not.
- **After "Paylaş"** the editor closes and the post appears first in the
  master's grid as **"Hazırlanır"**: a `Skeleton` tile. When processing
  finishes, it becomes the photo. If processing fails, the tile shows a `danger`
  icon and "Alınmadı"; tapping it offers delete.
- **Editing a published post** changes only the caption (ADR-0045 § 3), from
  "Redaktə et" in the master's own viewer, which opens the caption field alone.
- **Deleting:** "Sil" in the master's viewer opens a `Sheet`: "Bu paylaşım
  silinsin?", a `danger` button "Sil" and "Ləğv et".

### 6. Empty states

`EmptyState`, with the `Image` icon at `icon.size.lg` and no illustration (art
stays the owner's):

- **The customer, on a master with no posts:** "Usta hələ iş nümunəsi
  paylaşmayıb."
- **The master, on their own empty portfolio:** "Gördüyünüz işlərin şəkillərini
  paylaşın. Müştərilər sizi daha yaxşı tanıyacaq." and the "Yeni paylaşım"
  button.

### 7. The avatar

- **A circle**, as `Avatar` already draws it, at the sizes in § 1 and § 4. No
  avatar: the existing initials fallback.
- **Setting it:** the master taps their avatar on their own profile, which
  carries a small pencil mark on an `inverse-surface` circle so it reads as
  editable. A `Sheet` offers "Şəkil seç" and, when one is set, "Şəkli sil".
- **The crop is square**, made in the system picker's own editor
  (`allowsEditing` with a 1:1 aspect), and drawn as a circle. No crop screen of
  our own.

## Interim copy and content for the owner to accept

| Where              | Placeholder                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------- |
| Order screen row   | "Profilə bax"                                                                                 |
| Master home avatar | "Profilim" (accessibility label)                                                              |
| Profile headings   | "Xidmətlər", "İşlər"                                                                          |
| Bio overflow       | "Daha çox"                                                                                    |
| Editor             | "Yeni paylaşım", "Şəkil əlavə et", "Təsvir (istəyə bağlı)", "Xidmət (istəyə bağlı)", "Paylaş" |
| Post states        | "Hazırlanır", "Alınmadı"                                                                      |
| Delete sheet       | "Bu paylaşım silinsin?", "Sil", "Ləğv et"                                                     |
| Avatar sheet       | "Şəkil seç", "Şəkli sil"                                                                      |
| Empty, customer    | "Usta hələ iş nümunəsi paylaşmayıb."                                                          |
| Empty, master      | "Gördüyünüz işlərin şəkillərini paylaşın. Müştərilər sizi daha yaxşı tanıyacaq."              |
| Empty-state art    | None: the `Image` icon stands in until the owner supplies art                                 |

## Why

- **Nothing new where something existing fits.** The profile's rows, cards,
  badges, sheets and empty state are the components every other screen uses,
  so the profile reads as part of the same app. Only the grid and the viewer
  are new, because nothing like them exists.
- **The grid shows many photos at once.** Three square columns is the
  arrangement people already know from photo apps, and square `thumb` tiles
  keep the grid even whatever each photo's shape.
- **The viewer is dark in both themes** for the reason ADR-0041 gave the call
  screen: a photo is judged against black, and a light frame changes how it
  looks.
- **No motion was invented.** Zoom, swipe-to-close, swiping between posts and
  drag-to-reorder are motion, which CLAUDE.md §17 keeps the owner's. Every
  action has a plain control instead.

## Alternatives considered

| Option                                          | Why not                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Two columns, or tiles at each photo's own shape | Fewer photos per screen, and an uneven grid needs a masonry layout the list rules would have to bend for |
| The viewer as a bottom sheet over the profile   | Too small to judge a photo of work; a sheet is for choices, not for looking                              |
| The profile entry inside the status card        | The status card is about the order's state; the master is a separate thing to open, like "Mesajlar"      |
| The master's profile as a tab                   | The master has no tab bar yet (ADR-0036); a header control is the smaller step until they do             |
| Reordering photos in the editor                 | A drag gesture is motion (§17), and the order chosen is usually the order wanted                         |

## Trade-offs accepted

- **Square tiles crop.** The edges of a tall or wide photo are hidden in the
  grid; the viewer shows the whole photo.
- **No zoom.** A detail in a photo is seen at the `display` size (1440 px) and
  no closer, until the owner decides on zoom.
- **One more control on the master's home header**, until a tab bar replaces
  it.

## Consequences

- #313 builds `MediaGrid` and `MediaViewer` (photos only); #314 the editor and
  the avatar; #315 the customer's profile screen and the order-screen row. None
  of them has a visual decision left to make.
- The master's home header gains a second control. When the master gets a tab
  bar (ADR-0036), the profile becomes a tab and the header avatar goes.

## Revisit when

- The owner supplies a design for any of these screens, or art for the empty
  states.
- Video arrives (ADR-0045 § 7): the grid needs a video mark and the viewer a
  player.
