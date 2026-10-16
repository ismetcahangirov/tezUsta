import type { PortfolioPost } from '@tezusta/types';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  BackHandler,
  FlatList,
  Platform,
  ScrollView,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { Badge, CloseIcon, IconButton, PencilIcon, Text, Trash2Icon } from '../components';
import { cn } from '../lib/cn';
import { FixedScheme, space } from '../theme';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';
import { PortfolioPhoto } from './PortfolioPhoto';
import { PHOTO_SURFACE_SCHEME } from './viewer-surface';

export interface MediaViewerOwnerActions {
  /** "Redaktə et": the caption sheet (#314). */
  readonly onEdit: () => void;
  /** "Sil": the delete sheet (#314). */
  readonly onDelete: () => void;
}

export interface MediaViewerProps {
  readonly post: PortfolioPost;
  /** The photo to open on; the first when unset. */
  readonly initialIndex?: number;
  /**
   * The close button and the hardware back button. Inside a React Native
   * `Modal`, back never reaches `BackHandler`: a host that presents the viewer
   * in one wires this to the modal's `onRequestClose` too.
   */
  readonly onClose: () => void;
  /** The master's own copy only (ADR-0054 § 3). Unset, nobody can edit or delete. */
  readonly ownerActions?: MediaViewerOwnerActions;
}

/**
 * One post, full screen (ADR-0054 § 3): its photos paged horizontally, shown
 * whole at the `display` rendition, with its caption and service tag under
 * them.
 *
 * **Dark in both themes**, through `FixedScheme`, as the call surface is
 * (ADR-0041): a photo is judged against black. The photo has no radius: it is
 * the content, edge to edge.
 *
 * **Full-bleed and unpadded for the system bars,** like `CallScreen`: the
 * route that presents it owns the safe area. The hardware back button closes
 * it here rather than in the route, so it closes the same way wherever it is
 * presented.
 *
 * **No zoom, no swiping between posts, no swipe down to close**: each is
 * motion, which stays the owner's (CLAUDE.md §17). Every action has a control.
 */
export function MediaViewer({
  post,
  initialIndex = 0,
  onClose,
  ownerActions,
}: MediaViewerProps): React.JSX.Element {
  const window = useWindowDimensions();
  // Each page is the pager's own size, measured: the viewer need not fill the
  // window, and an unsized page would draw its photo at no height at all.
  const [page, setPage] = useState({ width: window.width, height: 0 });
  const total = post.media.length;
  // Read once: the list applies its initial index on mount and never again.
  const [openedOn] = useState(() => clamp(initialIndex, total));
  const [current, setCurrent] = useState(openedOn);
  const currentRef = useRef(current);
  currentRef.current = current;
  const listRef = useRef<FlatList<PortfolioPost['media'][number]>>(null);

  // Subscribed once, with the latest `onClose` read through a ref. A listener
  // re-added on every render would keep moving itself to the front of the
  // queue, ahead of a sheet opened over the viewer that wants back for itself.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onCloseRef.current();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, []);

  // The list placed its pages at the width it had on mount, which is the
  // window's until the pager is measured. Once the width is known, or changes
  // (a split screen, a rotation), put the current photo back in view.
  useEffect(() => {
    listRef.current?.scrollToOffset({
      offset: currentRef.current * page.width,
      animated: false,
    });
  }, [page.width]);

  // TalkBack hears the counter change through its live region; VoiceOver has
  // no live regions, so iOS is told in words.
  const announced = useRef(current);
  useEffect(() => {
    if (current === announced.current) {
      return;
    }
    announced.current = current;
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(copy.viewer.counter(current + 1, total));
    }
  }, [current, total]);

  const onPageLayout = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && (width !== page.width || height !== page.height)) {
      setPage({ width, height });
    }
  };

  // On the momentum's end and on a drag's end: a drag released exactly on a
  // page boundary has no momentum to end.
  const onPageSettled = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    setCurrent(clamp(Math.round(event.nativeEvent.contentOffset.x / page.width), total));
  };

  return (
    <FixedScheme scheme={PHOTO_SURFACE_SCHEME} className="flex-1 bg-inverse-surface">
      <StatusBar style="light" />

      <View className="flex-row items-center justify-between px-4 py-2">
        {total > 1 && (
          // Centred on the bar, whatever stands either side of it.
          <View
            pointerEvents="none"
            className="absolute bottom-0 left-0 right-0 top-0 items-center justify-center"
          >
            <Text variant="caption" tone="on-inverse" accessibilityLiveRegion="polite">
              {copy.viewer.counter(current + 1, total)}
            </Text>
          </View>
        )}
        <IconButton
          accessibilityLabel={copy.viewer.close}
          variant="surface"
          icon={<CloseIcon tone="text" />}
          onPress={onClose}
        />
        {ownerActions !== undefined && (
          <View className="flex-row gap-2">
            <IconButton
              accessibilityLabel={copy.viewer.edit}
              variant="surface"
              icon={<PencilIcon tone="text" />}
              onPress={ownerActions.onEdit}
            />
            <IconButton
              accessibilityLabel={copy.viewer.delete}
              variant="surface"
              icon={<Trash2Icon tone="text" />}
              onPress={ownerActions.onDelete}
            />
          </View>
        )}
      </View>

      <View testID="media-viewer-pages" className="flex-1" onLayout={onPageLayout}>
        <FlatList
          ref={listRef}
          testID="media-viewer-pager"
          data={post.media}
          keyExtractor={(media) => media.id}
          horizontal
          pagingEnabled
          scrollEnabled={total > 1}
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={openedOn}
          getItemLayout={(_, index) => ({
            length: page.width,
            offset: page.width * index,
            index,
          })}
          onMomentumScrollEnd={onPageSettled}
          onScrollEndDrag={onPageSettled}
          // Only the page on screen and its neighbours hold a 1440 px decode.
          windowSize={3}
          initialNumToRender={1}
          renderItem={({ item: media }) => (
            <View style={page}>
              <PortfolioPhoto
                uri={media.displayUrl}
                contentFit="contain"
                fallbackTone="on-inverse"
                className="flex-1"
              />
            </View>
          )}
        />
      </View>

      {total > 1 && <Dots current={current} total={total} />}

      {(post.caption !== null || post.service !== null) && (
        // A long caption scrolls in its own area, at most a third of the screen.
        <ScrollView
          // `flexGrow: 0`: a ScrollView grows by default, and would take the
          // photo's room even under a one-line caption.
          style={{ flexGrow: 0, maxHeight: window.height / 3 }}
          contentContainerStyle={{ gap: space[2], padding: space[4] }}
        >
          {post.caption !== null && (
            <Text variant="body" tone="on-inverse">
              {post.caption}
            </Text>
          )}
          {post.service !== null && <Badge label={post.service.name} />}
        </ScrollView>
      )}
    </FixedScheme>
  );
}

/**
 * Where the reader is among the photos: the current dot `on-inverse`, the rest
 * at 40 % (`VIEWER_INACTIVE_DOT_OPACITY`, measured in `contrast.test.ts`). The
 * counter says the same in words, so a screen reader skips the dots.
 */
function Dots({
  current,
  total,
}: {
  readonly current: number;
  readonly total: number;
}): React.JSX.Element {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="flex-row justify-center gap-2 py-4"
    >
      {Array.from({ length: total }, (_, index) => (
        <View
          key={index}
          className={cn('h-2 w-2 rounded-full bg-on-inverse', index !== current && 'opacity-40')}
        />
      ))}
    </View>
  );
}

function clamp(index: number, total: number): number {
  return Math.min(Math.max(index, 0), Math.max(total - 1, 0));
}
