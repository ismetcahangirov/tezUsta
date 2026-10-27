import { useState } from 'react';
import { Image, TextInput, View } from 'react-native';

import { Banner, Button, IconButton, ImageIcon, SendIcon, Text } from '../components';
import { space, typography, useTheme } from '../theme';
import { CONVERSATION_COPY as copy } from './conversation-copy';
import type { MessagePhotos } from './useMessagePhotos';

/**
 * The longest message the API accepts (`MAX_MESSAGE_BODY_LENGTH` in
 * `conversations.schema.ts`). Restated rather than imported — `apps/mobile`
 * may not import `apps/api` — and enforced by the field so the server's 422 is
 * never the first the user hears of it.
 */
export const MAX_MESSAGE_LENGTH = 2000;

/**
 * How many lines the field grows to before it scrolls inside itself.
 *
 * A count, not a size: the height is computed from the body type's own line
 * height and the field's padding tokens, so it stays true to the type scale if
 * either changes.
 */
const COMPOSER_MAX_LINES = 5;
const COMPOSER_MAX_HEIGHT = typography.scale.body.lineHeight * COMPOSER_MAX_LINES + space[3] * 2;

export interface ComposerProps {
  /** Receives the text as typed; trimming and the empty check are the caller's. */
  readonly onSend: (body: string) => void;
  /** Called on every change of the text — the typing signal throttles itself. */
  readonly onTyping?: (() => void) | undefined;
  /**
   * The photos waiting to go on the next message (#456). Unset, the composer
   * is text only. The caller takes them in `onSend`.
   */
  readonly photos?: MessagePhotos | undefined;
}

/**
 * Where a message is written ([ADR-0037](../../../../docs/decisions/ADR-0037-conversation-screen.md)).
 *
 * **The field and one round accent button**: the field takes the input's own
 * surface and hairline outline, rounded to `lg` rather than the full pill so
 * that a message of several lines still reads as one field; the send control is
 * the accent `IconButton`, the one call to action on the screen, which is what
 * the accent is for (`design-system.md` § 3).
 *
 * **Send is disabled until there is something to send**, and the field clears
 * the moment it is pressed — the message is already on screen as a bubble by
 * then, and a failed send keeps its own text on the bubble to retry, so
 * nothing the user wrote depends on the field keeping it.
 *
 * The composer is **absent**, not disabled, on a conversation that can no
 * longer be written to; that decision is the screen's, and this component has
 * no disabled state to be tempted by.
 *
 * **Photos** ([ADR-0067](../../../../docs/decisions/ADR-0067-conversation-photos.md)
 * § 1–2): a `surface` icon button with the `Image` icon opens the library, on
 * the left where the thumb that holds the phone does not cover it, and the
 * photos wait in a strip above the field, drawn as the order flow draws its
 * own (`CreateOrder.tsx`): the photo, its state in words, and "Sil". Send
 * waits until every photo has uploaded, so nothing chosen is silently left
 * behind, and a message of photos alone may be sent with no text.
 */
export function Composer({ onSend, onTyping, photos }: ComposerProps): React.JSX.Element {
  const { colors } = useTheme();
  const [text, setText] = useState('');
  const drafted = photos?.photos ?? [];
  const empty = text.trim() === '' && drafted.length === 0;
  const blocked = empty || photos?.ready === false;

  return (
    <View className="gap-2 pt-2">
      {photos?.permissionDenied === true ? (
        <Banner tone="neutral" message={copy.photoPermissionDenied} />
      ) : null}

      {drafted.length > 0 ? (
        <View className="flex-row flex-wrap gap-3">
          {drafted.map((photo) => (
            <View key={photo.localId} className="items-center gap-1">
              <Image
                source={{ uri: photo.uri }}
                accessibilityIgnoresInvertColors
                className="h-avatar-lg w-avatar-lg rounded-md"
              />
              {photo.status === 'ready' ? null : (
                <Text variant="footnote" tone={photo.status === 'failed' ? 'danger' : 'muted'}>
                  {photo.status === 'failed' ? copy.photoUploadFailed : copy.photoUploading}
                </Text>
              )}
              <Button
                label={copy.removePhoto}
                variant="ghost"
                size="sm"
                onPress={() => {
                  photos?.remove(photo.localId);
                }}
              />
            </View>
          ))}
        </View>
      ) : null}

      <View className="flex-row items-end gap-2">
        {photos === undefined ? null : (
          <IconButton
            accessibilityLabel={copy.attachPhoto}
            variant="surface"
            icon={<ImageIcon />}
            disabled={!photos.canAdd || photos.isPicking}
            onPress={() => void photos.pick()}
          />
        )}
        <TextInput
          accessibilityLabel={copy.composerLabel}
          placeholder={copy.composerPlaceholder}
          placeholderTextColor={colors['text-muted']}
          value={text}
          onChangeText={(next) => {
            setText(next);
            onTyping?.();
          }}
          multiline
          maxLength={MAX_MESSAGE_LENGTH}
          className="min-h-control-md flex-1 rounded-lg border-hairline border-border bg-surface px-5 py-3 text-body font-regular text-text"
          style={{ maxHeight: COMPOSER_MAX_HEIGHT }}
        />
        <IconButton
          accessibilityLabel={copy.send}
          variant="accent"
          icon={<SendIcon tone="on-accent" />}
          disabled={blocked}
          onPress={() => {
            if (blocked) {
              return;
            }
            onSend(text);
            setText('');
          }}
        />
      </View>
    </View>
  );
}
