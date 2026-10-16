import { memo, useCallback, useMemo } from 'react';
import { FlatList, Pressable, View, type ListRenderItem } from 'react-native';

import { CircleAlertIcon, CopyIcon, Text } from '../components';
import { cn } from '../lib/cn';
import { FixedScheme, space } from '../theme';
import type { MediaGridItem } from './media-grid-items';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';
import { PortfolioPhoto } from './PortfolioPhoto';
import { PHOTO_SURFACE_SCHEME } from './viewer-surface';

/** Three square columns (ADR-0054 § 2). */
export const MEDIA_GRID_COLUMNS = 3;

export interface MediaGridProps {
  /** Newest first, as the server sent them (`gridItemsFromPosts`). */
  readonly items: readonly MediaGridItem[];
  /**
   * A published tile was tapped: its post, and the post's place in `items`.
   * `gridIndex` is not a photo index: a tile always opens its post on the
   * first photo, so the viewer needs no `initialIndex` from here.
   */
  readonly onOpen: (postId: string, gridIndex: number) => void;
  /**
   * A failed tile was tapped: the master's own grid opens the delete sheet
   * (ADR-0054 § 5). Unset, a failed tile is not pressable.
   */
  readonly onPressFailed?: (postId: string) => void;
  /** The list nears its end: ask for the next page (ADR-0054 § 2). */
  readonly onEndReached?: () => void;
  /** Scrolls with the tiles, above them: the profile's header. */
  readonly header?: React.ReactElement;
  /** Drawn in place of the tiles when there are none (ADR-0054 § 6). */
  readonly empty?: React.ReactElement;
  /** Under the tiles: a further page's retry, or room at the end. */
  readonly footer?: React.ReactElement;
}

/** A cell of the list: a tile, or an empty cell that keeps the last row's tiles square. */
type GridCell = MediaGridItem | { readonly kind: 'spacer'; readonly postId: string };

const TILE_CLASS = 'aspect-square flex-1 overflow-hidden rounded-sm';

/**
 * The portfolio grid (ADR-0054 § 2): three columns of square tiles, a
 * `space.1` gap, each the post's first photo at the `thumb` rendition.
 *
 * **A list, never a `.map()`** (`performance.md`): a profile can hold sixty
 * posts, and only the rows on screen are mounted.
 *
 * **The last row is padded with empty cells.** Every tile is `flex-1` in its
 * row, so a row of one would stretch its tile across the screen. Empty cells
 * keep each tile a third wide without measuring the list first.
 */
export function MediaGrid({
  items,
  onOpen,
  onPressFailed,
  onEndReached,
  header,
  empty,
  footer,
}: MediaGridProps): React.JSX.Element {
  const cells = useMemo(() => withSpacers(items), [items]);

  // Stable across the profile's own re-renders (a refetch, the bio expanding),
  // so the memoised tiles on screen are not all drawn again.
  const renderItem = useCallback<ListRenderItem<GridCell>>(
    ({ item: cell, index }) => {
      switch (cell.kind) {
        case 'published':
          return <PublishedTile item={cell} gridIndex={index} onOpen={onOpen} />;
        case 'processing':
          return <ProcessingTile />;
        case 'failed':
          return <FailedTile postId={cell.postId} onPress={onPressFailed} />;
        case 'spacer':
          return <View className="flex-1" />;
      }
    },
    [onOpen, onPressFailed],
  );

  return (
    <FlatList
      testID="media-grid"
      data={cells}
      keyExtractor={(cell) => cell.postId}
      numColumns={MEDIA_GRID_COLUMNS}
      columnWrapperStyle={{ gap: space[1] }}
      ItemSeparatorComponent={RowGap}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      onEndReached={onEndReached}
      // Half a screen before the end, so the next page is usually there when
      // the reader arrives. React Native's default is two screens, which on a
      // profile of 18 posts would ask for the next page the moment it mounts.
      onEndReachedThreshold={0.5}
      renderItem={renderItem}
    />
  );
}

/** The cells, with empty ones after the last tile until its row is full. */
function withSpacers(items: readonly MediaGridItem[]): GridCell[] {
  const missing = (MEDIA_GRID_COLUMNS - (items.length % MEDIA_GRID_COLUMNS)) % MEDIA_GRID_COLUMNS;

  return [
    ...items,
    ...Array.from({ length: missing }, (_, i) => ({
      kind: 'spacer' as const,
      postId: `spacer-${String(i)}`,
    })),
  ];
}

function RowGap(): React.JSX.Element {
  return <View className="h-1" />;
}

const PublishedTile = memo(function PublishedTile({
  item,
  gridIndex,
  onOpen,
}: {
  readonly item: Extract<MediaGridItem, { kind: 'published' }>;
  readonly gridIndex: number;
  readonly onOpen: (postId: string, gridIndex: number) => void;
}): React.JSX.Element {
  const label = copy.grid.tile(item.photoCount);

  return (
    <Pressable
      accessibilityRole="button"
      // The caption is the post's own words: a reader hears what the photo
      // shows, not only that there is one.
      accessibilityLabel={item.caption === null ? label : `${label}. ${item.caption}`}
      onPress={() => {
        onOpen(item.postId, gridIndex);
      }}
      className={cn(TILE_CLASS, 'bg-surface-alt active:opacity-80')}
    >
      {/* The tile's label already says what this is; the photo, and its
          fallback, would only repeat it as a second stop. */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="flex-1"
      >
        <PortfolioPhoto
          uri={item.thumbUrl}
          contentFit="cover"
          fallbackTone="text-muted"
          className="flex-1"
        />
      </View>
      {item.photoCount > 1 && <StackMark />}
    </Pressable>
  );
});

/**
 * The mark on a post with more than one photo, top right, inset `space.2`.
 * Pinned to the light palette: it sits on a photo whatever the theme, and the
 * dark palette's `on-inverse` on `overlay` is `#111` on `#000` (ADR-0054 § 2).
 * The scrim is `Addresses.tsx`'s `overlay` at 60 %.
 */
function StackMark(): React.JSX.Element {
  return (
    <FixedScheme scheme={PHOTO_SURFACE_SCHEME} className="absolute right-2 top-2">
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="h-6 w-6 items-center justify-center rounded-full bg-overlay/60"
      >
        <CopyIcon size="sm" tone="on-inverse" />
      </View>
    </FixedScheme>
  );
}

/** A post the server is still making renditions for. Not pressable (ADR-0054 § 5). */
function ProcessingTile(): React.JSX.Element {
  return (
    <View className={cn(TILE_CLASS, 'items-center justify-center bg-surface-alt')}>
      <Text variant="footnote" tone="muted">
        {copy.grid.processing}
      </Text>
    </View>
  );
}

/** A post whose photos could not be processed (ADR-0054 § 5). */
function FailedTile({
  postId,
  onPress,
}: {
  readonly postId: string;
  readonly onPress: ((postId: string) => void) | undefined;
}): React.JSX.Element {
  const content = (
    <>
      <CircleAlertIcon tone="danger" />
      <Text variant="footnote" tone="danger">
        {copy.grid.failed}
      </Text>
    </>
  );
  const tileClass = cn(TILE_CLASS, 'items-center justify-center gap-1 bg-surface');

  if (onPress === undefined) {
    return <View className={tileClass}>{content}</View>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copy.grid.failed}
      onPress={() => {
        onPress(postId);
      }}
      className={cn(tileClass, 'active:opacity-80')}
    >
      {content}
    </Pressable>
  );
}
