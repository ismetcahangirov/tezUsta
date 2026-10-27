# ADR-0067 — Photos in the conversation

- **Status:** **Accepted (layout by delegation; the copy is the owner's to replace)**
- **Date:** 2026-10-27
- **Decided by:** Project owner. On 27 October 2026 the owner delegated the layout ("Chat şəkli, dizayn mənə") when asked whether to build the conversation's photo picker with the layout proposed, or wait for a design.
- **Context:** EPIC 18 (#175), issue [#456]. Unblocks the message-attachment half of #319.
- **Builds on:** [ADR-0033](ADR-0033-in-order-messaging.md) § 4 (photos on the order-photo upload path), [ADR-0037](ADR-0037-conversation-screen.md) (the conversation screen; its "Revisit when: attachments land" is this), [ADR-0024](ADR-0024-presigned-upload-mechanism.md) (presign, `PUT`, confirm), [ADR-0054](ADR-0054-master-profile-and-portfolio-screens.md) § 6 (the `Image` icon for a photo that did not load).

[#456]: https://github.com/ismetcahangirov/tezUsta/issues/456

## Context

Since #181 the API has accepted photos on a message: a presign, a `PUT` straight to storage, a confirm, and `attachmentIds` on the send. Since #318 it re-encodes each photo before it can be sent. No client has ever sent a photo or drawn one. ADR-0037 left the photo bubble to the moment attachments landed, and #319 waits on "the attachment picker" for its message half.

Three facts of the API shape the client:

- The server keeps **one outstanding presign per side** of a conversation and clears the previous one when asked for another.
- A send that arrives while a photo is still being re-encoded is refused with `409 MESSAGE_ATTACHMENT_PROCESSING`, and nothing is written. `422 MESSAGE_ATTACHMENT_UNUSABLE` is final.
- A photo's read URL is a presigned GET that lives `UPLOAD_DOWNLOAD_TTL_SECONDS`, 120 s by default. The bucket has no public URL (ADR-0005).

## Decision

1. **The photo control.** An `IconButton` (`surface`, the `Image` icon), labelled "Şəkil əlavə et", sits at the composer's left, before the field. It opens the system library with multiple selection, limited to the room left on the message (four, the API's bound). It is disabled while the library is open and when the message is full. The library permission is asked the first time it is pressed, as for an order's photos. A refusal shows a neutral `Banner` above the composer, and text still works.
2. **The waiting strip.** Chosen photos wait above the field in a wrapping row, drawn as the order flow draws its own (`CreateOrder.tsx`). Each has the photo (`avatar-lg` square, `rounded-md`), its state in words under it ("Yüklənir…" muted, "Yüklənmədi" in danger, nothing once uploaded), and a ghost "Sil". **Send waits until every photo has uploaded**, so a failed photo must be removed rather than being silently left out. A message of photos alone may be sent with no text.
3. **The bubble.** Photos sit **inside** the bubble, above the text, on the same side and surface as text messages (ADR-0037). The bubble then takes the full width inside its gutter, with `p-1` around the photos. They are laid out in rows of two `flex-1 aspect-square` tiles, the portfolio grid's tile, rounded `sm`. A lone last photo keeps its square beside an empty cell, and a single photo is drawn at the bubble's full width. A photo that does not load shows the `Image` icon (ADR-0054 § 6). An empty body draws no line of text. The time and delivery line keep their place under the photos.
4. **Expired URLs.** A photo that fails to load once its URL has expired (with 30 s allowed for clock skew) re-reads the history. The history is not cached across screens (ADR-0005). The re-read is rate-limited to once every 30 s per screen, so a photo that fails for another reason cannot start a loop.
5. **Sending.**
   - Uploads run **one at a time**, from one queue, because a second presign would cancel the first.
   - The optimistic bubble draws the phone's prepared JPEGs until the server's message replaces it.
   - A `PROCESSING` refusal is sent again automatically after 1, 2, 3, 4 and 5 s, and only then fails. This is not the silent retry `sendMessage`'s `maxRetries: 0` forbids: the server has said it wrote nothing, so a second attempt cannot post twice.
   - `UNUSABLE` fails the bubble with no resend.
6. **No full-screen viewer** and no tap target on a photo. The portfolio's `MediaViewer` is built around a post, and a viewer for the conversation is a separate piece of work. Motion stays the owner's.

## Alternatives considered

- **Send each photo as soon as it is picked**, as some chat apps do. Rejected: the API takes text and photos as one message, and a photo with its explanation is the common case ("Kranın altı belədir"). A caption added later would be a second message.
- **Let send carry the photos that uploaded and drop the failed ones**, as order creation allows. Rejected for a chat: the user would see a photo in the strip that the other party never receives. A message is cheap to send again once the photo is removed.
- **Upload in parallel** (the portfolio runs two at a time). Not possible: the conversation's single outstanding presign per side would cancel the first.
- **`expo-image` with a memory cache keyed by attachment id**, so a scrolled-back photo would not need a new URL. Rejected for now: the order screen's private photos use React Native's `Image` with short-lived URLs (`OrderPhotoThumbnail`), and one approach for private photos is easier to reason about than two. Revisit if the re-reads show up in measurements.

## Trade-offs accepted

- A photo the server cannot process leaves a failed bubble with no resend and no dismiss control. It stays until the app restarts. This matches a message refused because the order ended.
- The prepared JPEGs of a message that failed and is never resent stay in the app's cache until the OS reclaims it. The JPEGs of a sent message, a removed photo and a closed screen are deleted (#408).
- Scrolling back to an old photo after two minutes costs a re-read of the loaded history pages.
- Nothing has been run on a device. The tests mock the picker, the manipulator and the file system.

## Consequences

- `apps/mobile/src/conversation/`:
  - new `useMessagePhotos.ts` and `MessagePhotoGrid.tsx`;
  - `Composer` takes an optional `photos`;
  - `MessageBubble` takes `photos` and `onPhotoExpired`;
  - the outbox entries carry `photos` and `unsendable`;
  - `useSendMessage.send` takes the photos;
  - `conversation-endpoints.ts` gains `presignMessagePhoto` and `confirmMessagePhoto`, and `sendMessage` sends `attachmentIds`.
- **Placeholder copy for the owner:** `attachPhoto`, `removePhoto`, `photoUploading`, `photoUploadFailed`, `photoPermissionDenied`, `photo` and `photoFailed` in `conversation-copy.ts`.
- #319's message half is built. Its iPhone check now covers a conversation photo too.

## Revisit when

- The owner supplies a design for the strip, the bubble, or a photo viewer.
- A viewer is wanted: it is what makes a photo tappable.
- Device measurements show the history re-reads for expired URLs are a real cost.
