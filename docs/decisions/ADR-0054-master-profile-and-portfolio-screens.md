# ADR-0054 — The master profile, portfolio grid, photo viewer and post editor

- **Status:** Accepted (copy and empty-state art pending)
- **Date:** 2026-10-14
- **Decided by:** The owner delegated the design of #303 on 14 October 2026
  ("sən özün necə istəyirsənsə elə et"). Engineering laid it out inside the
  design system (ADR-0011, ADR-0048), as ADR-0035 and ADR-0036 were, and
  showed the owner a six-screen mockup, which they accepted as recommended
  ("necə məsləhətdirsə"). The copy and the empty-state art stay the owner's.
- **Amends:** [ADR-0036](ADR-0036-master-work-surface.md): the master's home
  header gains a control that opens their own profile (§ 4). And
  [`design-system.md`](../design/design-system.md) § 6: the viewer's photo is a
  second square-edged element (§ 3).
- **Context:** issue #303; EPIC 19 (#301)
- **Builds on:** [ADR-0045](ADR-0045-master-portfolio.md) (what the profile
  shows, who sees it, photos only, only the caption editable),
  [ADR-0041](ADR-0041-call-surface-fixed-appearance.md) (a full-screen surface
  with a fixed appearance)

## Context

ADR-0045 settled what the profile shows and who may see it. CLAUDE.md §17 makes
how it looks the owner's, and the owner delegated it. The design system settles
colour, type, spacing, radius and the component inventory, but has no profile
header, media grid or full-screen viewer.

Video is deferred (ADR-0045 § 7), so nothing here plays, marks or controls one.

## Decision

Sizes are tokens: `space.1` 4, `space.2` 8, `space.6` 24 and so on; type roles
are the design system's (`h1`, `body`, `caption`, `footnote`).

### 1. The profile screen

One pushed screen, the same for both readers: `(customer)/order/[id]/master`
for the customer and `(master)/profile` for the master. Top to bottom:

1. **The header row:** the title "Usta" (the master's own: "Profilim") in `h1`
   and "Geri", as every pushed screen has.
2. **The identity block**, on the page and not in a card:
   - the avatar at `avatar-lg` (64), a circle, from the 512 px rendition (the
     128 px one serves `avatar-sm` and `avatar-md`);
   - beside it, the display name in `h1`, at most two lines, then truncated;
   - under the name, the rating as `PartyRatingLine` with its label hidden
     visually and kept as the accessibility label (§ 9);
   - under both, the bio in `body`, at most four lines. A longer bio ends with
     "Daha çox" in `body-strong`, a text button with a 44 px tap area; tapping
     it shows the rest. No bio: nothing, not a placeholder.
3. **Services:** a `Card` titled "Xidmətlər" (`h2`), one `ListRow` per active
   service, the master's price as its trailing content in `body-strong`. No
   services: the card is not drawn.
4. **The portfolio:** "İşlər" (`h2`), then the grid (§ 2), or the empty state
   (§ 6).

On their own profile the master also sees a primary `Button` "Yeni paylaşım"
under the identity block, and their avatar is pressable (§ 7). With an empty
portfolio that button is not drawn: the empty state carries it (§ 6). At the
post limit (`PORTFOLIO_MAX_POSTS`) it is disabled, with a `footnote` under it:
"Ən çox 60 paylaşım ola bilər."

**Loading, failure and absence.**

- While the profile is read: a `Skeleton` in the identity block's shape and
  six grid-tile `Skeleton`s. Nothing else.
- A failed read: `EmptyState` "Profil açılmadı." with a "Yenidən cəhd et"
  `Button`.
- A 404 (the window closed, the master was suspended or deleted; ADR-0045 § 2):
  `EmptyState` "Bu profil artıq göstərilmir." with a "Geri" `Button`. The app
  does not try to tell these causes apart; it cannot, and need not.

### 2. The grid

- **Three columns of square tiles**, a `space.1` (4 px) gap, `radius.sm`
  corners. Each tile is the post's first photo at the `thumb` rendition,
  cropped to the square (`contentFit="cover"`). The viewer shows the whole
  photo.
- **A post with more than one photo** carries a stack mark in its top right
  corner, inset `space.2`: the `Copy` icon at `icon.size.sm`, `on-inverse`, on
  an `overlay` circle `space.6` (24) across at 60 % opacity, the opacity
  `Addresses.tsx` already uses for `overlay`. The mark is drawn under
  `FixedScheme` light, as ADR-0041's call surface is, so it is white on a dark
  circle in both themes. (In the dark palette `on-inverse` is `#111` and
  `overlay` is `#000`, which would be invisible.)
- **Newest first** (ADR-0045 § 3). The grid reads 30 posts at a time and asks
  for the next 30 when the end of the list comes into view. There is no
  end-of-list marker.
- Tapping a tile opens the viewer on that post. The tile's accessibility label
  is "Paylaşım" and, with several photos, "Paylaşım, 3 şəkil".

### 3. The photo viewer

- **Full screen, over everything, under `FixedScheme` light** (ADR-0041): the
  surface is `inverse-surface` (`#111`), type is `on-inverse`, and muted type
  is `on-inverse` at 80 %, as ADR-0041 settled. The status bar is light.
- **One post at a time.** Its photos page horizontally with a swipe, shown
  whole (`contentFit="contain"`) at the `display` rendition. The photo has no
  radius: it is the content, edge to edge, not a surface on the page. **This
  is the second square-edged element** after the progress bar, and
  `design-system.md` § 6 is amended to say so.
- **The top bar:** a close `IconButton`, variant `surface` with the `X` icon in
  `text`, on the left, as ADR-0041's close button. With more than one photo,
  "2 / 5" in `caption` in the centre.
- **Under the photo**, with more than one: a row of dots, `space.2` (8) across
  with a `space.2` gap. The current one is `on-inverse`; the rest are
  `on-inverse` at 40 %, about 3.8:1 on `#111`, above the 3:1 floor for
  non-text. The counter says the same in words.
- **The bottom:** the caption in `body` and, when there is one, the service
  tag as a `Badge`. A long caption scrolls in its own area, at most a third of
  the screen. **No date is shown**: ADR-0045 § 1 lists the profile's fields,
  and a publication date is not one of them.
- **The master's own copy** adds two `IconButton`s, variant `surface`, on the
  right of the top bar: "Redaktə et" (`Pencil`) and "Sil" (`Trash2`).
  - "Redaktə et" opens a `Sheet` with the caption's multi-line `TextField` and
    its counter, "Yadda saxla" (primary) and "Ləğv et".
  - "Sil" opens the delete `Sheet` (§ 5).
- **Not in it:** pinch to zoom, swiping between posts and swiping down to
  close. Each is motion, which stays the owner's (CLAUDE.md §17). Android's
  back button closes the viewer.

### 4. The entry points

**The customer's order screen.** A `ListRow` in a `Card` showing the master's
avatar at `avatar-sm` in a new leading slot (§ 9), their name, "Profilə bax" as
the subtitle and a `ChevronRight` as trailing. It sits directly above
"Mesajlar", after the tracking map, so the order's own state (the status card,
the review prompt, the report entry) stays at the top.

**It shows only once the profile read for this order has succeeded.** While it
loads, after a failure, and on a 404, the row is not drawn. The server alone
decides who may see the profile (ADR-0045 § 2), so the row follows its answer:
a cancellation, a re-dispatch, a closed window or a suspension all remove it
without the app knowing which.

**The master's home.** Their avatar at `avatar-md` (44, the touch target) sits
in the header row, left of the settings button, labelled "Profilim". It opens
§ 1. When the master gets a tab bar (ADR-0036), the profile becomes a tab and
this control goes.

### 5. The post editor

A pushed screen, `(master)/post/new`, titled "Yeni paylaşım", opened from
"Yeni paylaşım".

- **Choosing photos:** a secondary `Button` "Şəkil əlavə et (3 / 10)", counting
  against `PORTFOLIO_MAX_ITEMS_PER_POST`, opens the system picker with multiple
  selection. Chosen photos appear in a **two-column** strip of square tiles,
  `radius.sm`, a `space.1` gap, in the order chosen. **No reordering**: a drag
  is motion. A master who wants another order removes a photo and adds it
  again.
- **Two columns, not three,** because each tile carries two 44 px controls. On
  a 360 px phone a third-width tile is about 101 px and they would overlap; a
  half-width tile is about 154 px.
- **Each tile:**
  - a remove `IconButton` (`X`), variant `surface`, inset `space.1` in the top
    right corner, labelled "Şəkli çıxar";
  - while uploading, a `ProgressBar` along its bottom, inset `space.2`;
  - if the upload failed, the photo is dimmed under `overlay` at 60 %, with a
    retry `IconButton` (`RotateCw`), variant `surface`, in the centre,
    labelled "Yenidən yüklə", and "Alınmadı" in `caption`, `on-inverse`,
    under it. Drawn under `FixedScheme` light, as the stack mark (§ 2).
- **Caption:** a multi-line `TextField` (the composer's treatment, design
  system § 6) labelled "Təsvir (istəyə bağlı)", with a counter under it at the
  right in `footnote`, `text-muted`: "44 / 500". The report form draws its
  counter the same way.
- **Service tag:** "Xidmət (istəyə bağlı)", the master's active services as
  check rows, as the report form chooses a reason (ADR-0053). Tapping the
  chosen row again clears it. The tag cannot be changed after publishing
  (ADR-0045 § 3).
- **"Paylaş"**, the primary button, at the foot. It is enabled once every
  photo has uploaded and at least one is left. While it is not, a `footnote`
  under it reads "Bütün şəkillər yüklənəndə aktiv olur."
- **Leaving with work in it:** "Geri" or the back button, with any photo
  chosen, opens a `Sheet`: "Paylaşım atılsın?", a `danger` button "At" and
  "Davam et". Uploads already finished are swept as abandoned (ADR-0045).
- **After "Paylaş"** the editor closes and the post appears first in the
  master's grid:
  - **processing:** a tile in `surface-alt` with "Hazırlanır" centred in
    `footnote`, `text-muted`. Not pressable.
  - **published:** the photo, as any tile.
  - **failed:** a tile in `surface` with the `CircleAlert` icon in `danger` and
    "Alınmadı" in `footnote`, `danger`, under it. Pressing it opens the delete
    `Sheet`.
- **Deleting** (from the viewer or a failed tile): a `Sheet` with "Bu paylaşım
  silinsin?", a `danger` button "Sil" and "Ləğv et".

### 6. Empty states

`EmptyState`, with the `Image` icon at `icon.size.lg`, `text-muted`, in a new
icon slot (§ 9). There is no illustration; art stays the owner's.

- **The customer, on a master with no posts:** title "Usta hələ iş nümunəsi
  paylaşmayıb."
- **The master, on their own empty portfolio:** title "Hələ paylaşım yoxdur",
  description "Gördüyünüz işlərin şəkillərini paylaşın. Müştərilər sizi daha
  yaxşı tanıyacaq.", and the "Yeni paylaşım" `Button` as its action.

### 7. The avatar

- **A circle**, as `Avatar` draws it, with its initials fallback when there is
  none.
- **On the master's own profile it is pressable**, labelled "Profil şəklini
  dəyiş", and carries a pencil mark at its bottom right: the `Pencil` icon at
  `icon.size.sm`, `on-inverse`, on an `inverse-surface` circle `space.6` (24)
  across. In the dark palette that is a white circle with a dark pencil, which
  reads on the dark page, so it is not pinned.
- **Pressing it** opens a `Sheet`: "Şəkil seç" and, when one is set, "Şəkli
  sil", then "Ləğv et".
- **The crop is square**, made in the system picker's own editor
  (`allowsEditing` with a 1:1 aspect), and drawn as a circle. There is no crop
  screen of our own.
- **While a new avatar uploads and is processed,** the old one (or the
  initials) stays, because the keys swap only once the new renditions exist
  (ADR-0045 § 8), and "Şəkil hazırlanır…" shows under the name in `caption`,
  `text-muted`. A failure replaces that line with a `Banner` "Şəkil
  yüklənmədi." and a "Yenidən cəhd et" action.

### 8. Dark theme

Every surface above uses role tokens, so it follows the theme, with two
exceptions pinned to the light palette: the viewer (§ 3) and the marks drawn
over a photo (§ 2, § 5). Both sit on a photo or on black whatever the theme.

### 9. What the components need

The ADR uses existing components where they fit. Where one falls short, the
implementing issue extends it:

| Component          | Change                                                                     | Issue |
| ------------------ | -------------------------------------------------------------------------- | ----- |
| `EmptyState`       | An optional `icon` slot: an icon, not an illustration                      | #313  |
| `ListRow`          | An optional `leading` slot, for the avatar                                 | #315  |
| `PartyRatingLine`  | Hide the label visually and keep it as the accessibility label             | #315  |
| `icons.tsx`        | `ImageIcon`, `CopyIcon`, `RotateCwIcon` and `CircleAlertIcon`, from Lucide | #313  |
| New: `MediaGrid`   | § 2, with the stack mark and the processing and failed tiles               | #313  |
| New: `MediaViewer` | § 3                                                                        | #313  |
| New: `PostEditor`  | § 5, with its photo strip                                                  | #314  |

The character counter is a `Text` under the field, as the report form draws
it, not a `TextField` feature.

## Interim copy for the owner to accept

| Where                    | Placeholder                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Profile titles           | "Usta"; for the master, "Profilim"                                                                                                     |
| Profile headings         | "Xidmətlər", "İşlər"                                                                                                                   |
| Rating label (not shown) | "Ustanın reytinqi", read by a screen reader                                                                                            |
| Bio overflow             | "Daha çox"                                                                                                                             |
| Post limit               | "Ən çox 60 paylaşım ola bilər."                                                                                                        |
| Profile failures         | "Profil açılmadı.", "Yenidən cəhd et", "Bu profil artıq göstərilmir.", "Geri"                                                          |
| Order screen row         | "Profilə bax"                                                                                                                          |
| Master home avatar       | "Profilim" (accessibility label)                                                                                                       |
| Grid tile labels         | "Paylaşım", "Paylaşım, 3 şəkil"                                                                                                        |
| Viewer                   | "Bağla", "Redaktə et", "Sil", "Yadda saxla", "Ləğv et"                                                                                 |
| Editor                   | "Yeni paylaşım", "Şəkil əlavə et", "Təsvir (istəyə bağlı)", "Xidmət (istəyə bağlı)", "Paylaş", "Bütün şəkillər yüklənəndə aktiv olur." |
| Editor tiles             | "Şəkli çıxar", "Yenidən yüklə", "Alınmadı"                                                                                             |
| Leaving the editor       | "Paylaşım atılsın?", "At", "Davam et"                                                                                                  |
| Post states              | "Hazırlanır", "Alınmadı"                                                                                                               |
| Delete sheet             | "Bu paylaşım silinsin?", "Sil", "Ləğv et"                                                                                              |
| Avatar                   | "Profil şəklini dəyiş", "Şəkil seç", "Şəkli sil", "Şəkil hazırlanır…", "Şəkil yüklənmədi."                                             |
| Empty, customer          | "Usta hələ iş nümunəsi paylaşmayıb."                                                                                                   |
| Empty, master            | "Hələ paylaşım yoxdur", "Gördüyünüz işlərin şəkillərini paylaşın. Müştərilər sizi daha yaxşı tanıyacaq."                               |
| Empty-state art          | None: the `Image` icon stands in until the owner supplies art                                                                          |

## Why

- **Nothing new where something existing fits.** The profile's rows, cards,
  badges, sheets and empty states are the components every other screen uses,
  so the profile reads as part of the same app. Only the grid, the viewer and
  the editor are new, because nothing like them exists.
- **The grid shows many photos at once.** Three square columns is the
  arrangement people already know from photo apps, and the cover crop keeps the
  grid even whatever each photo's shape.
- **The viewer is dark in both themes** for the reason ADR-0041 gave the call
  screen: a photo is judged against black, and a light frame changes how it
  looks.
- **The server decides visibility, and the app follows it** (§ 1, § 4). The
  app cannot see a suspension or work out every window rule, and does not
  need to.
- **No motion was invented.** Zoom, swipe-to-close, swiping between posts and
  drag-to-reorder are motion, which CLAUDE.md §17 keeps the owner's. Every
  action has a plain control instead.

## Alternatives considered

| Option                                          | Why not                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Two columns, or tiles at each photo's own shape | Fewer photos per screen, and an uneven grid needs a masonry layout the list rules would have to bend for |
| Square-cornered grid tiles                      | A third square-edged element; `radius.sm` keeps the tiles inside the design system's rule                |
| The viewer as a bottom sheet over the profile   | Too small to judge a photo of work; a sheet is for choices, not for looking                              |
| The profile entry inside the status card        | The status card is about the order's state; the master is a separate thing to open, like "Mesajlar"      |
| Drawing the order-screen row from the order     | The order carries no name or avatar, and the app cannot tell when ADR-0045 § 2 stops allowing the read   |
| The master's profile as a tab                   | The master has no tab bar yet (ADR-0036); a header control is the smaller step until they do             |
| A three-column editor strip                     | Two 44 px controls overlap on a 101 px tile                                                              |
| Reordering photos in the editor                 | A drag gesture is motion (§17), and the order chosen is usually the order wanted                         |
| A publication date in the viewer                | Not a field ADR-0045 § 1 allows, and it can tie a post to a job by its timing                            |

## Trade-offs accepted

- **Square tiles crop.** The edges of a tall or wide photo are hidden in the
  grid; the viewer shows the whole photo.
- **No zoom.** A detail is seen at the `display` size (1440 px) and no closer,
  until the owner decides on zoom.
- **The order-screen row appears late.** It waits for the profile read, so it
  can arrive a moment after the rest of the screen.
- **One more control on the master's home header**, until a tab bar replaces
  it.

## Consequences

- #313 builds `MediaGrid` and `MediaViewer` (photos only) and the component
  changes in § 9. #314 builds the editor and the avatar. #315 builds the
  customer's profile screen and the order-screen row. None of them has a
  visual decision left to make.
- `design-system.md` § 6 names the viewer's photo as the second square-edged
  element.

## Revisit when

- The owner supplies a design for any of these screens, art for the empty
  states, or a decision on zoom or other motion.
- Video arrives (ADR-0045 § 7): the grid needs a video mark and the viewer a
  player.
