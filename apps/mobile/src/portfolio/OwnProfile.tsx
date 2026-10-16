import { skipToken } from '@reduxjs/toolkit/query';
import type { MasterPublicProfile, OwnPortfolioPost } from '@tezusta/types';
import { useCallback, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Banner, Button, EmptyState, ImageIcon, Sheet, Text, TextField } from '../components';
import { useOwnMasterQuery } from '../master-jobs/master-jobs-endpoints';
import { FixedScheme, useTheme, type ColorScheme } from '../theme';
import { useMasterProfileQuery } from './master-profile-endpoints';
import { MasterProfileHeader } from './MasterProfileHeader';
import { GridSkeleton, ProfileFrame, ProfileSkeleton } from './MasterProfile';
import { gridItemsFromOwnPosts, viewablePost } from './media-grid-items';
import { MediaGrid } from './MediaGrid';
import { MediaViewer } from './MediaViewer';
import {
  useDeletePostMutation,
  useOwnPostsInfiniteQuery,
  useUpdatePostMutation,
} from './portfolio-endpoints';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';
import { PORTFOLIO_CAPTION_MAX_CHARS } from './PostEditor';
import { useAvatarUpload } from './useAvatarUpload';
import { useBoundedRefresh } from './useBoundedRefresh';
import { useViewerStatusBar } from './useViewerStatusBar';
import { PHOTO_SURFACE_SCHEME } from './viewer-surface';

/**
 * How many posts a master may have. Mirrors the server's default
 * `PORTFOLIO_MAX_POSTS`, which it enforces at publish; this only disables
 * "Yeni paylaşım" and says why (ADR-0054 § 1).
 */
export const PORTFOLIO_MAX_POSTS = 60;

/** While a post processes, its grid is re-read this often, at most this many times (#314). */
export const PROCESSING_REFRESH_MS = 5_000;
export const PROCESSING_REFRESH_ATTEMPTS = 36;

/** The scrim the sheets sit under: `Addresses.tsx`'s `overlay` at 60 %. */
const SCRIM_CLASS = 'bg-overlay/60';

export interface OwnProfileProps {
  /** Whether the screen is in front: processing is waited for only while it is. */
  readonly focused: boolean;
  readonly onBack: () => void;
  /** Opens the post editor (ADR-0054 § 5). */
  readonly onNewPost: () => void;
}

/**
 * The master's own profile (ADR-0054 § 1, #314): the same screen the customer
 * sees, titled "Profilim", with the master's controls. **It is the preview**:
 * the header and services are the public profile the customer reads, so the
 * master sees themselves as a customer does, plus:
 *
 * - "Yeni paylaşım" under the identity block (in the empty state when there is
 *   nothing yet), disabled at the post limit with a footnote saying so;
 * - the avatar as a control, with its sheet ("Şəkil seç", "Şəkli sil");
 * - every post they have, not only published ones: processing and failed
 *   posts are marked, and the grid is re-read a bounded number of times while
 *   one processes and the screen is in front;
 * - edit and delete in the viewer, and delete on a failed tile. A delete
 *   leaves the grid at once and comes back if the server refuses.
 *
 * **A master who is not active** (not yet verified, or suspended) cannot post;
 * they are told so, rather than shown a profile the server will not serve.
 */
export function OwnProfile({ focused, onBack, onNewPost }: OwnProfileProps): React.JSX.Element {
  const own = useOwnMasterQuery();
  const master = own.currentData;
  const active = master?.verificationStatus === 'active';
  const profile = useMasterProfileQuery(master !== undefined && active ? master.id : skipToken);

  const frame = (children: React.ReactNode): React.JSX.Element => (
    <ProfileFrame onBack={onBack} title={copy.own.title}>
      {children}
    </ProfileFrame>
  );

  if (master !== undefined && !active) {
    return frame(
      <EmptyState title={copy.own.notActive} icon={<ImageIcon size="lg" tone="text-muted" />} />,
    );
  }

  if (profile.currentData === undefined) {
    const failed = own.isError || profile.isError;
    return frame(
      failed ? (
        <EmptyState
          title={copy.profile.errorTitle}
          action={
            <Button
              label={copy.profile.retry}
              onPress={() => {
                void (own.isError ? own.refetch() : profile.refetch());
              }}
            />
          }
        />
      ) : (
        <ProfileSkeleton />
      ),
    );
  }

  return frame(
    <LoadedOwnProfile profile={profile.currentData} focused={focused} onNewPost={onNewPost} />,
  );
}

type SheetState =
  | { readonly kind: 'none' }
  | { readonly kind: 'edit'; readonly postId: string }
  | { readonly kind: 'delete'; readonly postId: string }
  | { readonly kind: 'avatar' };

interface LoadedOwnProfileProps {
  readonly profile: MasterPublicProfile;
  readonly focused: boolean;
  readonly onNewPost: () => void;
}

function LoadedOwnProfile({
  profile,
  focused,
  onNewPost,
}: LoadedOwnProfileProps): React.JSX.Element {
  const posts = useOwnPostsInfiniteQuery();
  const own = useMemo(
    () => posts.currentData?.pages.flatMap((page) => page.items) ?? [],
    [posts.currentData],
  );
  const items = useMemo(() => gridItemsFromOwnPosts(own), [own]);
  const anyProcessing = items.some((item) => item.kind === 'processing');
  const postCount = items.length;

  useBoundedRefresh({
    enabled: focused && anyProcessing,
    refetch: posts.refetch,
    intervalMs: PROCESSING_REFRESH_MS,
    maxAttempts: PROCESSING_REFRESH_ATTEMPTS,
  });

  const avatar = useAvatarUpload();
  const [updatePost, updateResult] = useUpdatePostMutation();
  // The page's own scheme, for a sheet opened over the viewer: the viewer is
  // pinned dark, and its sheets are the page's, not the photo's.
  const pageScheme = useTheme().scheme;
  const [deletePost] = useDeletePostMutation();
  const [deleteFailed, setDeleteFailed] = useState(false);

  const [openPostId, setOpenPostId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState>({ kind: 'none' });
  const statusBar = useViewerStatusBar();

  // Read through a ref, so a re-read of the list does not hand the grid a new
  // `onOpen` and redraw every tile.
  const ownRef = useRef(own);
  ownRef.current = own;

  const openPost = useMemo(() => {
    const post = own.find((candidate) => candidate.id === openPostId);
    return post === undefined ? null : viewablePost(post);
  }, [own, openPostId]);

  const onOpen = useCallback(
    (postId: string) => {
      const post = ownRef.current.find((candidate) => candidate.id === postId);
      if (post === undefined || viewablePost(post) === null) {
        return;
      }
      statusBar.beforeOpen();
      setOpenPostId(postId);
    },
    [statusBar],
  );

  const closeViewer = useCallback(() => {
    statusBar.afterClose();
    setOpenPostId(null);
    setSheet({ kind: 'none' });
  }, [statusBar]);

  const onPressFailed = useCallback((postId: string) => {
    setSheet({ kind: 'delete', postId });
  }, []);

  const confirmDelete = async (postId: string): Promise<void> => {
    setSheet({ kind: 'none' });
    if (openPostId === postId) {
      closeViewer();
    }
    setDeleteFailed(false);
    try {
      await deletePost(postId).unwrap();
    } catch {
      setDeleteFailed(true);
    }
  };

  const atLimit = postCount >= PORTFOLIO_MAX_POSTS;

  const header = (
    <View className="gap-6 pb-4">
      <MasterProfileHeader
        profile={profile}
        onEditAvatar={() => {
          setSheet({ kind: 'avatar' });
        }}
        belowName={
          <AvatarStatus
            phase={avatar.phase}
            permissionDenied={avatar.permissionDenied}
            onRetry={avatar.retry}
          />
        }
      />
      {postCount > 0 && (
        <View className="gap-2">
          <Button label={copy.own.newPost} disabled={atLimit} onPress={onNewPost} />
          {atLimit && (
            <Text variant="footnote" tone="muted">
              {copy.own.postLimit(PORTFOLIO_MAX_POSTS)}
            </Text>
          )}
        </View>
      )}
      {deleteFailed && <Banner tone="danger" message={copy.manage.deleteFailed} />}
      <Text variant="h2" accessibilityRole="header">
        {copy.profile.worksTitle}
      </Text>
    </View>
  );

  const editing = sheet.kind === 'edit' ? own.find((post) => post.id === sheet.postId) : undefined;

  const sheetContent =
    sheet.kind === 'edit' && editing !== undefined ? (
      <EditCaptionSheet
        post={editing}
        saving={updateResult.isLoading}
        failed={updateResult.isError}
        onCancel={() => {
          setSheet({ kind: 'none' });
        }}
        onSave={(caption) => {
          void updatePost({ postId: editing.id, caption })
            .unwrap()
            .then(() => {
              setSheet({ kind: 'none' });
            })
            .catch(() => undefined);
        }}
      />
    ) : sheet.kind === 'delete' ? (
      <Sheet title={copy.manage.deleteTitle}>
        <View className="gap-3">
          <Button
            label={copy.manage.delete}
            variant="danger"
            fullWidth
            onPress={() => {
              void confirmDelete(sheet.postId);
            }}
          />
          <Button
            label={copy.manage.cancel}
            variant="secondary"
            fullWidth
            onPress={() => {
              setSheet({ kind: 'none' });
            }}
          />
        </View>
      </Sheet>
    ) : sheet.kind === 'avatar' ? (
      <Sheet>
        <View className="gap-3">
          <Button
            label={copy.avatar.pick}
            fullWidth
            // One avatar on its way at a time.
            disabled={avatar.phase === 'working'}
            onPress={() => {
              setSheet({ kind: 'none' });
              void avatar.change();
            }}
          />
          {profile.avatarLargeUrl !== null && (
            <Button
              label={copy.avatar.remove}
              variant="secondary"
              fullWidth
              loading={avatar.removing}
              onPress={() => {
                setSheet({ kind: 'none' });
                void avatar.remove();
              }}
            />
          )}
          <Button
            label={copy.avatar.cancel}
            variant="ghost"
            fullWidth
            onPress={() => {
              setSheet({ kind: 'none' });
            }}
          />
        </View>
      </Sheet>
    ) : null;

  const closeSheet = (): void => {
    setSheet({ kind: 'none' });
  };

  return (
    <>
      <MediaGrid
        items={items}
        onOpen={onOpen}
        onPressFailed={onPressFailed}
        onEndReached={() => {
          if (posts.hasNextPage && !posts.isFetching) {
            void posts.fetchNextPage();
          }
        }}
        header={header}
        empty={
          posts.currentData !== undefined ? (
            <EmptyState
              title={copy.own.emptyTitle}
              description={copy.own.emptyDescription}
              icon={<ImageIcon size="lg" tone="text-muted" />}
              action={<Button label={copy.own.newPost} onPress={onNewPost} />}
            />
          ) : posts.isError ? (
            <EmptyState
              title={copy.profile.errorTitle}
              action={
                <Button
                  label={copy.profile.retry}
                  loading={posts.isFetching}
                  onPress={() => {
                    void posts.refetch();
                  }}
                />
              }
            />
          ) : (
            <GridSkeleton />
          )
        }
        footer={<View className="h-10" />}
      />

      {/* The viewer, with the master's edit and delete; their sheets open over it. */}
      <Modal
        visible={openPost !== null}
        animationType="none"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={sheetContent !== null ? closeSheet : closeViewer}
      >
        {openPost !== null && (
          <FixedScheme scheme={PHOTO_SURFACE_SCHEME} className="flex-1 bg-inverse-surface">
            <SafeAreaView className="flex-1">
              <MediaViewer
                post={openPost}
                onClose={closeViewer}
                ownerActions={{
                  onEdit: () => {
                    // A failure from an earlier edit is not this one's.
                    updateResult.reset();
                    setSheet({ kind: 'edit', postId: openPost.id });
                  },
                  onDelete: () => {
                    setSheet({ kind: 'delete', postId: openPost.id });
                  },
                }}
              />
            </SafeAreaView>
            {sheetContent !== null && (
              <SheetOverlay onDismiss={closeSheet} scheme={pageScheme}>
                {sheetContent}
              </SheetOverlay>
            )}
          </FixedScheme>
        )}
      </Modal>

      {/* A sheet opened from the page itself: a failed tile, or the avatar. */}
      <Modal
        visible={openPost === null && sheetContent !== null}
        transparent
        animationType="none"
        onRequestClose={closeSheet}
      >
        <SheetOverlay onDismiss={closeSheet}>{sheetContent}</SheetOverlay>
      </Modal>
    </>
  );
}

/**
 * A sheet at the bottom, over the scrim; tapping the scrim dismisses it. It
 * rises with the keyboard, so the caption field and "Yadda saxla" stay in view.
 * Given a `scheme` (over the viewer, which is pinned dark), the sheet is drawn
 * in the page's own palette rather than the viewer's.
 */
function SheetOverlay({
  onDismiss,
  scheme,
  children,
}: {
  readonly onDismiss: () => void;
  readonly scheme?: ColorScheme;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const sheet = <View>{children}</View>;
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="absolute inset-0 justify-end"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.manage.cancel}
        onPress={onDismiss}
        className={`absolute inset-0 ${SCRIM_CLASS}`}
      />
      {scheme === undefined ? sheet : <FixedScheme scheme={scheme}>{sheet}</FixedScheme>}
    </KeyboardAvoidingView>
  );
}

/** The caption's edit (ADR-0054 § 3): the field, its counter, save and cancel. */
function EditCaptionSheet({
  post,
  saving,
  failed,
  onCancel,
  onSave,
}: {
  readonly post: OwnPortfolioPost;
  readonly saving: boolean;
  readonly failed: boolean;
  readonly onCancel: () => void;
  readonly onSave: (caption: string | null) => void;
}): React.JSX.Element {
  const [caption, setCaption] = useState(post.caption ?? '');
  const length = Array.from(caption).length;

  return (
    <Sheet>
      <View className="gap-1">
        <TextField
          label={copy.editor.caption}
          value={caption}
          onChangeText={setCaption}
          multiline
          maxLength={PORTFOLIO_CAPTION_MAX_CHARS}
          editable={!saving}
        />
        <Text variant="footnote" tone="muted" className="self-end">
          {copy.editor.counter(length, PORTFOLIO_CAPTION_MAX_CHARS)}
        </Text>
      </View>
      {failed && <Banner tone="danger" message={copy.manage.saveFailed} />}
      <View className="gap-3">
        <Button
          label={copy.manage.save}
          fullWidth
          loading={saving}
          onPress={() => {
            const trimmed = caption.trim();
            onSave(trimmed === '' ? null : trimmed);
          }}
        />
        <Button
          label={copy.manage.cancel}
          variant="secondary"
          fullWidth
          disabled={saving}
          onPress={onCancel}
        />
      </View>
    </Sheet>
  );
}

/**
 * Under the name while a new avatar is on its way (ADR-0054 § 7): "Şəkil
 * hazırlanır…", or, if it failed, a banner with a retry. The old avatar, or the
 * initials, stays meanwhile.
 */
function AvatarStatus({
  phase,
  permissionDenied,
  onRetry,
}: {
  readonly phase: 'idle' | 'working' | 'failed';
  readonly permissionDenied: boolean;
  readonly onRetry: () => Promise<void>;
}): React.JSX.Element | null {
  if (permissionDenied && phase === 'idle') {
    return <Banner tone="danger" message={copy.editor.permissionDenied} />;
  }
  if (phase === 'working') {
    return (
      <Text variant="caption" tone="muted" accessibilityLiveRegion="polite">
        {copy.avatar.processing}
      </Text>
    );
  }
  if (phase === 'failed') {
    return (
      <Banner
        tone="danger"
        message={copy.avatar.failed}
        action={
          <Button
            label={copy.avatar.retry}
            variant="ghost"
            size="sm"
            onPress={() => {
              void onRetry();
            }}
          />
        }
      />
    );
  }
  return null;
}
