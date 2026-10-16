import type { MasterPublicService } from '@tezusta/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Modal, Pressable, ScrollView, View } from 'react-native';

import {
  Banner,
  Button,
  Card,
  CheckIcon,
  CloseIcon,
  IconButton,
  ListRow,
  ProgressBar,
  RotateCwIcon,
  Sheet,
  Text,
  TextField,
} from '../components';
import { errorCodeOf } from '../master-jobs/error-code';
import { FixedScheme } from '../theme';
import { usePublishPostMutation, useUpdatePostMutation } from './portfolio-endpoints';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';
import { PortfolioPhoto } from './PortfolioPhoto';
import {
  PORTFOLIO_MAX_ITEMS_PER_POST,
  usePortfolioUpload,
  type UploadItem,
} from './usePortfolioUpload';
import { PHOTO_SURFACE_SCHEME } from './viewer-surface';

/**
 * A caption's length. Mirrors the server's default `PORTFOLIO_CAPTION_MAX_CHARS`,
 * which it enforces; the field stops typing at it.
 */
export const PORTFOLIO_CAPTION_MAX_CHARS = 500;

/** Two columns: each tile carries two 44 px controls (ADR-0054 § 5). */
const STRIP_COLUMNS = 2;

/** The scrim the sheets and a failed photo sit under: `Addresses.tsx`'s `overlay` at 60 %. */
const SCRIM_CLASS = 'bg-overlay/60';

export interface PostEditorProps {
  /** The master's active services, for the optional tag. */
  readonly services: readonly MasterPublicService[];
  /** Back out, or done: the editor has nothing left to do. */
  readonly onClose: () => void;
}

/**
 * A new post (ADR-0054 § 5, #314): photos, an optional caption and service
 * tag, and "Paylaş".
 *
 * **"Paylaş" waits for every photo.** It is enabled once each chosen photo has
 * uploaded and at least one is left; a footnote says so while it is not.
 * Publishing sets the caption and the tag first, because the tag cannot be
 * changed after (ADR-0045 § 3), and then publishes. The editor then closes and
 * the post appears first in the master's grid, processing.
 *
 * **Leaving with photos chosen asks first** ("Paylaşım atılsın?"), from "Geri"
 * and from the hardware back button. "At" deletes the draft; uploads already
 * finished are swept with it.
 *
 * No reordering: a drag is motion, which stays the owner's (CLAUDE.md §17).
 */
export function PostEditor({ services, onClose }: PostEditorProps): React.JSX.Element {
  const upload = usePortfolioUpload();
  const [caption, setCaption] = useState('');
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [updatePost, updateResult] = useUpdatePostMutation();
  const [publishPost, publishResult] = usePublishPostMutation();
  const [publishFailed, setPublishFailed] = useState(false);

  const publishing = updateResult.isLoading || publishResult.isLoading;
  const hasWork = upload.items.length > 0;

  const postId = upload.postId;
  const discardDraft = upload.discard;
  const requestLeave = useCallback((): void => {
    if (publishing) {
      // The post is being published: there is nothing left to abandon.
      return;
    }
    if (hasWork) {
      setLeaving(true);
      return;
    }
    if (postId !== null) {
      // Every photo was removed, but the draft they were in remains: it goes too.
      void discardDraft();
    }
    onClose();
  }, [discardDraft, hasWork, onClose, postId, publishing]);

  // The hardware back button asks the same question "Geri" does.
  const requestLeaveRef = useRef(requestLeave);
  requestLeaveRef.current = requestLeave;
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      requestLeaveRef.current();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, []);

  const discard = async (): Promise<void> => {
    setLeaving(false);
    await upload.discard();
    onClose();
  };

  const publish = async (): Promise<void> => {
    if (postId === null || !upload.ready) {
      return;
    }
    setPublishFailed(false);
    try {
      const trimmed = caption.trim();
      if (trimmed !== '' || serviceId !== null) {
        await updatePost({
          postId,
          caption: trimmed === '' ? null : trimmed,
          serviceId,
        }).unwrap();
      }
      try {
        await publishPost(postId).unwrap();
      } catch (error) {
        // "Not ready": the server holds a photo this editor no longer does (a
        // removal whose delete was lost). Bring the draft in line, once, and
        // publish again; anything else is a failure to show.
        if (errorCodeOf(error) !== 'PORTFOLIO_POST_NOT_READY' || !(await upload.reconcile())) {
          throw error;
        }
        await publishPost(postId).unwrap();
      }
      onClose();
    } catch {
      setPublishFailed(true);
    }
  };

  const count = upload.items.length;
  const captionLength = Array.from(caption).length;

  return (
    <View className="flex-1 gap-4 px-6 pt-6">
      <View className="flex-row items-center justify-between">
        <Text variant="h1" accessibilityRole="header">
          {copy.editor.title}
        </Text>
        <Button
          label={copy.editor.back}
          variant="ghost"
          size="sm"
          disabled={publishing}
          onPress={requestLeave}
        />
      </View>

      <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
        <View className="gap-6 pb-10">
          <View className="gap-3">
            <Button
              label={copy.editor.addPhotos(count, PORTFOLIO_MAX_ITEMS_PER_POST)}
              variant="secondary"
              loading={upload.isPicking}
              disabled={count >= PORTFOLIO_MAX_ITEMS_PER_POST || publishing}
              onPress={() => {
                void upload.pick();
              }}
            />
            {upload.permissionDenied && (
              <Banner tone="danger" message={copy.editor.permissionDenied} />
            )}
            {count > 0 && (
              <PhotoStrip
                items={upload.items}
                onRemove={upload.remove}
                onRetry={upload.retry}
                disabled={publishing}
              />
            )}
          </View>

          <View className="gap-1">
            <TextField
              label={copy.editor.caption}
              value={caption}
              onChangeText={setCaption}
              multiline
              maxLength={PORTFOLIO_CAPTION_MAX_CHARS}
              editable={!publishing}
            />
            <Text variant="footnote" tone="muted" className="self-end">
              {copy.editor.counter(captionLength, PORTFOLIO_CAPTION_MAX_CHARS)}
            </Text>
          </View>

          {services.length > 0 && (
            <View className="gap-2">
              <Text variant="h2">{copy.editor.service}</Text>
              <Card className="py-0">
                {services.map((service) => {
                  const selected = service.serviceId === serviceId;
                  return (
                    <ListRow
                      key={service.serviceId}
                      title={service.name}
                      accessibilityLabel={
                        selected ? `${service.name}, ${copy.editor.selected}` : service.name
                      }
                      trailing={selected ? <CheckIcon tone="text" /> : undefined}
                      onPress={() => {
                        // Tapping the chosen row again clears it (ADR-0054 § 5).
                        setServiceId(selected ? null : service.serviceId);
                      }}
                    />
                  );
                })}
              </Card>
            </View>
          )}

          <View className="gap-2">
            {publishFailed && <Banner tone="danger" message={copy.editor.publishFailed} />}
            <Button
              label={copy.editor.publish}
              fullWidth
              loading={publishing}
              disabled={!upload.ready || publishing}
              onPress={() => {
                void publish();
              }}
            />
            {!upload.ready && (
              <Text variant="footnote" tone="muted" className="text-center">
                {copy.editor.publishHint}
              </Text>
            )}
          </View>
        </View>
      </ScrollView>

      <Modal
        visible={leaving}
        transparent
        animationType="none"
        onRequestClose={() => {
          setLeaving(false);
        }}
      >
        <View className="flex-1 justify-end">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.editor.leaveContinue}
            onPress={() => {
              setLeaving(false);
            }}
            className={`absolute inset-0 ${SCRIM_CLASS}`}
          />
          <Sheet title={copy.editor.leaveTitle}>
            <View className="gap-3">
              <Button
                label={copy.editor.leaveDiscard}
                variant="danger"
                fullWidth
                onPress={() => {
                  void discard();
                }}
              />
              <Button
                label={copy.editor.leaveContinue}
                variant="secondary"
                fullWidth
                onPress={() => {
                  setLeaving(false);
                }}
              />
            </View>
          </Sheet>
        </View>
      </Modal>
    </View>
  );
}

interface PhotoStripProps {
  readonly items: readonly UploadItem[];
  readonly onRemove: (localId: string) => void;
  readonly onRetry: (localId: string) => void;
  readonly disabled: boolean;
}

/**
 * The chosen photos, two to a row, square, in the order chosen (ADR-0054 § 5).
 * At most ten, so a plain layout rather than a list. Empty cells keep a last
 * row of one a half wide.
 */
function PhotoStrip({ items, onRemove, onRetry, disabled }: PhotoStripProps): React.JSX.Element {
  const rows: (UploadItem | null)[][] = [];
  for (let start = 0; start < items.length; start += STRIP_COLUMNS) {
    const row: (UploadItem | null)[] = items.slice(start, start + STRIP_COLUMNS);
    while (row.length < STRIP_COLUMNS) {
      row.push(null);
    }
    rows.push(row);
  }

  return (
    <View className="gap-1">
      {rows.map((row, index) => (
        <View key={index} className="flex-row gap-1">
          {row.map((item, column) =>
            item === null ? (
              <View key={`empty-${String(column)}`} className="flex-1" />
            ) : (
              <StripTile
                key={item.localId}
                item={item}
                onRemove={onRemove}
                onRetry={onRetry}
                disabled={disabled}
              />
            ),
          )}
        </View>
      ))}
    </View>
  );
}

interface StripTileProps {
  readonly item: UploadItem;
  readonly onRemove: (localId: string) => void;
  readonly onRetry: (localId: string) => void;
  readonly disabled: boolean;
}

/**
 * One chosen photo (ADR-0054 § 5): a remove control top right; a progress bar
 * along the bottom while it uploads; and, if it failed, dimmed under the scrim
 * with a retry in the centre and "Alınmadı" under it, drawn in the light
 * palette because it sits on a photo.
 */
function StripTile({ item, onRemove, onRetry, disabled }: StripTileProps): React.JSX.Element {
  const sending = item.status === 'preparing' || item.status === 'uploading';

  return (
    <View className="aspect-square flex-1 overflow-hidden rounded-sm bg-surface-alt">
      <PortfolioPhoto
        uri={item.previewUri}
        contentFit="cover"
        fallbackTone="text-muted"
        className="flex-1"
      />

      {sending && (
        <View className="absolute bottom-2 left-2 right-2">
          <ProgressBar
            accessibilityLabel={copy.editor.uploading}
            value={Math.round(item.progress * 100)}
            max={100}
          />
        </View>
      )}

      {item.status === 'failed' && (
        <FixedScheme
          scheme={PHOTO_SURFACE_SCHEME}
          className={`absolute inset-0 items-center justify-center gap-1 ${SCRIM_CLASS}`}
        >
          <IconButton
            accessibilityLabel={copy.editor.retryPhoto}
            variant="surface"
            icon={<RotateCwIcon tone="text" />}
            disabled={disabled}
            onPress={() => {
              onRetry(item.localId);
            }}
          />
          <Text variant="caption" tone="on-inverse">
            {copy.editor.photoFailed}
          </Text>
        </FixedScheme>
      )}

      <View className="absolute right-1 top-1">
        <IconButton
          accessibilityLabel={copy.editor.removePhoto}
          variant="surface"
          icon={<CloseIcon tone="text" />}
          disabled={disabled}
          onPress={() => {
            onRemove(item.localId);
          }}
        />
      </View>
    </View>
  );
}
