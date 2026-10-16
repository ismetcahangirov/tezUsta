import { skipToken } from '@reduxjs/toolkit/query';
import type { MasterPublicProfile, PortfolioPost } from '@tezusta/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, StatusBar, View, type StatusBarProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, EmptyState, ImageIcon, Skeleton, Text } from '../components';
import { useOrderQuery } from '../orders/order-endpoints';
import { FixedScheme } from '../theme';
import { useMasterPortfolioInfiniteQuery, useMasterProfileQuery } from './master-profile-endpoints';
import { MasterProfileHeader } from './MasterProfileHeader';
import { gridItemsFromPosts } from './media-grid-items';
import { MEDIA_GRID_COLUMNS, MediaGrid } from './MediaGrid';
import { MediaViewer } from './MediaViewer';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';
import { PHOTO_SURFACE_SCHEME } from './viewer-surface';

export interface MasterProfileProps {
  /** The order the customer came from; its master is the one shown. */
  readonly orderId: string;
  readonly onBack: () => void;
}

export interface MasterProfileViewProps {
  readonly masterId: string;
  readonly onBack: () => void;
}

/** Six skeleton tiles while the profile is read: two rows (ADR-0054 § 1). */
const SKELETON_ROWS = 2;

/**
 * The master on the customer's order, as the customer sees them (ADR-0054 § 1,
 * issue #315): who they are, their services and their work.
 *
 * **The order is the only thing it is told**, as on the order screen: the
 * master comes from the order (already cached, since this screen is pushed
 * from it). An order that no longer has a master is answered like a 404.
 * Everything after that is `MasterProfileView`'s.
 */
export function MasterProfile({ orderId, onBack }: MasterProfileProps): React.JSX.Element {
  const order = useOrderQuery(orderId);
  const current = order.currentData;

  if (current === undefined) {
    if (isGone(order.error)) {
      return <GoneProfile onBack={onBack} />;
    }
    return order.isError ? (
      <FailedProfile
        onBack={onBack}
        onRetry={() => {
          void order.refetch();
        }}
      />
    ) : (
      <ProfileFrame onBack={onBack}>
        <ProfileSkeleton />
      </ProfileFrame>
    );
  }

  if (current.masterId === null) {
    return <GoneProfile onBack={onBack} />;
  }

  return <MasterProfileView masterId={current.masterId} onBack={onBack} />;
}

/**
 * One master's profile, from their id: the screen the customer reaches from an
 * order, and the one the master's "view as customer" preview (#314) shows.
 *
 * **Whether the reader may see it is the server's answer** (ADR-0045 § 2).
 * Four states: skeletons while it is read, "Profil açılmadı." with a retry,
 * "Bu profil artıq göstərilmir." for a 404 (a closed window, a suspension, a
 * deletion: the app cannot tell them apart and need not), and the profile.
 * Nothing about the master's position is here (ADR-0035).
 *
 * **The grid is the screen's one list**: the header scrolls with it, and the
 * next 30 posts are asked for as its end nears (ADR-0054 § 2). Tapping a tile
 * opens the viewer over everything, in a `Modal`, on the post's first photo.
 */
export function MasterProfileView({ masterId, onBack }: MasterProfileViewProps): React.JSX.Element {
  const profile = useMasterProfileQuery(masterId);

  if (isGone(profile.error)) {
    return <GoneProfile onBack={onBack} />;
  }

  if (profile.currentData === undefined) {
    return profile.isError ? (
      <FailedProfile
        onBack={onBack}
        onRetry={() => {
          void profile.refetch();
        }}
      />
    ) : (
      <ProfileFrame onBack={onBack}>
        <ProfileSkeleton />
      </ProfileFrame>
    );
  }

  return (
    <ProfileFrame onBack={onBack}>
      <LoadedProfile
        masterId={masterId}
        profile={profile.currentData}
        onGone={() => {
          // A further page answered 404: the profile is no longer shown to
          // this reader. Re-reading it turns the screen into the gone state.
          void profile.refetch();
        }}
      />
    </ProfileFrame>
  );
}

function GoneProfile({ onBack }: { readonly onBack: () => void }): React.JSX.Element {
  return (
    <ProfileFrame onBack={onBack}>
      <EmptyState
        title={copy.profile.goneTitle}
        action={<Button label={copy.profile.back} variant="secondary" onPress={onBack} />}
      />
    </ProfileFrame>
  );
}

function FailedProfile({
  onBack,
  onRetry,
}: {
  readonly onBack: () => void;
  readonly onRetry: () => void;
}): React.JSX.Element {
  return (
    <ProfileFrame onBack={onBack}>
      <EmptyState
        title={copy.profile.errorTitle}
        action={<Button label={copy.profile.retry} onPress={onRetry} />}
      />
    </ProfileFrame>
  );
}

interface LoadedProfileProps {
  readonly masterId: string;
  readonly profile: MasterPublicProfile;
  readonly onGone: () => void;
}

function LoadedProfile({ masterId, profile, onGone }: LoadedProfileProps): React.JSX.Element {
  // The further pages are not asked for until the grid nears its end. If the
  // profile is re-read and its cursor moves (a new post), the pages restart
  // from the new cursor; the overlap is dropped by `withoutDuplicates`.
  const [wantsMore, setWantsMore] = useState(false);
  const after = profile.nextCursor;
  const more = useMasterPortfolioInfiniteQuery(
    wantsMore && after !== null ? { masterId, after } : skipToken,
  );

  const pageGone = isGone(more.error);
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;
  useEffect(() => {
    if (pageGone) {
      onGoneRef.current();
    }
  }, [pageGone]);

  const posts = useMemo(
    () =>
      withoutDuplicates([
        ...profile.posts,
        ...(more.currentData?.pages.flatMap((page) => page.items) ?? []),
      ]),
    [profile.posts, more.currentData],
  );
  const items = useMemo(() => gridItemsFromPosts(posts), [posts]);

  // Read through a ref, so a new page does not hand the grid a new `onOpen`
  // and redraw every tile already on screen.
  const postsRef = useRef(posts);
  postsRef.current = posts;

  const [openPost, setOpenPost] = useState<PortfolioPost | null>(null);
  const statusBarEntry = useRef<StatusBarProps | null>(null);

  const onOpen = useCallback((postId: string) => {
    const post = postsRef.current.find((candidate) => candidate.id === postId);
    if (post === undefined) {
      return;
    }
    // Light status bar text before the modal exists: a modal takes the
    // window's status bar appearance when it is shown, and the viewer is dark
    // in both themes (ADR-0054 § 3). Popped again on close, which restores
    // whatever the app's own `StatusBar` set.
    statusBarEntry.current ??= StatusBar.pushStackEntry({
      barStyle: 'light-content',
      animated: false,
    });
    setOpenPost(post);
  }, []);

  const closeViewer = useCallback(() => {
    if (statusBarEntry.current !== null) {
      StatusBar.popStackEntry(statusBarEntry.current);
      statusBarEntry.current = null;
    }
    setOpenPost(null);
  }, []);

  useEffect(
    () => () => {
      if (statusBarEntry.current !== null) {
        StatusBar.popStackEntry(statusBarEntry.current);
      }
    },
    [],
  );

  // A reader who reaches the end while a page is still on its way is not
  // dropped: the wish is kept and the next page follows once that one lands.
  // A failed page waits for the footer's retry instead of being asked again.
  const [wantsNext, setWantsNext] = useState(false);
  const { hasNextPage, isFetching, isError, fetchNextPage } = more;
  useEffect(() => {
    if (!wantsNext || isFetching || isError) {
      return;
    }
    setWantsNext(false);
    if (hasNextPage) {
      void fetchNextPage();
    }
  }, [wantsNext, isFetching, isError, hasNextPage, fetchNextPage]);

  const onEndReached = useCallback(() => {
    if (after === null) {
      return;
    }
    if (wantsMore) {
      setWantsNext(true);
    } else {
      setWantsMore(true);
    }
  }, [after, wantsMore]);

  const header = (
    <View className="gap-6 pb-4">
      <MasterProfileHeader profile={profile} />
      <Text variant="h2" accessibilityRole="header">
        {copy.profile.worksTitle}
      </Text>
    </View>
  );

  return (
    <>
      <MediaGrid
        items={items}
        onOpen={onOpen}
        onEndReached={onEndReached}
        header={header}
        empty={
          <EmptyState
            title={copy.profile.emptyTitle}
            icon={<ImageIcon size="lg" tone="text-muted" />}
          />
        }
        footer={
          more.isError && !more.isFetching && !pageGone ? (
            <View className="items-center py-4">
              <Button
                label={copy.profile.retry}
                variant="secondary"
                onPress={() => {
                  void (more.currentData === undefined ? more.refetch() : more.fetchNextPage());
                }}
              />
            </View>
          ) : (
            <View className="h-10" />
          )
        }
      />

      <Modal
        visible={openPost !== null}
        animationType="none"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={closeViewer}
      >
        {openPost !== null && (
          // The viewer is full-bleed; the system bars' insets are drawn in its
          // own dark surface, so they read as part of it.
          <FixedScheme scheme={PHOTO_SURFACE_SCHEME} className="flex-1 bg-inverse-surface">
            <SafeAreaView className="flex-1">
              <MediaViewer post={openPost} onClose={closeViewer} />
            </SafeAreaView>
          </FixedScheme>
        )}
      </Modal>
    </>
  );
}

/** A post on two pages is drawn once: the first copy wins. */
function withoutDuplicates(posts: readonly PortfolioPost[]): PortfolioPost[] {
  const seen = new Set<string>();
  return posts.filter((post) => {
    if (seen.has(post.id)) {
      return false;
    }
    seen.add(post.id);
    return true;
  });
}

function isGone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return false;
  }
  const { status } = error as { status?: unknown };
  return status === 404 || status === 403;
}

/** The identity block's shape and six tiles (ADR-0054 § 1). Nothing else. */
function ProfileSkeleton(): React.JSX.Element {
  return (
    <View className="gap-6">
      <View className="flex-row items-center gap-4">
        <Skeleton className="h-avatar-lg w-avatar-lg rounded-full" />
        <View className="flex-1 gap-2">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
        </View>
      </View>
      <View className="gap-1">
        {Array.from({ length: SKELETON_ROWS }, (_, row) => (
          <View key={row} className="flex-row gap-1">
            {Array.from({ length: MEDIA_GRID_COLUMNS }, (_, column) => (
              <View key={column} className="flex-1">
                <Skeleton className="aspect-square w-full rounded-sm" />
              </View>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

interface ProfileFrameProps {
  readonly onBack: () => void;
  readonly children: React.ReactNode;
}

/** The title row every state shares, so back is reachable from all of them. */
function ProfileFrame({ onBack, children }: ProfileFrameProps): React.JSX.Element {
  return (
    <View className="flex-1 gap-4 px-6 pt-6">
      <View className="flex-row items-center justify-between">
        <Text variant="h1" accessibilityRole="header">
          {copy.profile.title}
        </Text>
        <Button label={copy.profile.back} variant="ghost" size="sm" onPress={onBack} />
      </View>
      {children}
    </View>
  );
}
