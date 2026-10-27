import { useState } from 'react';
import { Image, View } from 'react-native';

import { ImageIcon } from '../components';
import { CONVERSATION_COPY as copy } from './conversation-copy';

/**
 * How early a failed photo counts as expired. The URL's expiry is the server's
 * clock and the check is the phone's, so a few seconds of skew must not stop
 * a dead link from being replaced.
 */
const EXPIRY_MARGIN_MS = 30_000;

/** One photo on a message: the server's presigned GET, or the phone's own copy while unsent. */
export interface BubblePhoto {
  readonly key: string;
  readonly uri: string;
  /** When a presigned URL stops working, ISO 8601; unset for a local file, which does not. */
  readonly expiresAt?: string | undefined;
}

export interface MessagePhotoGridProps {
  readonly photos: readonly BubblePhoto[];
  /** On the user's own bubble, `inverse-surface`: decides the fallback icon's tone. */
  readonly mine: boolean;
  /** A photo failed after its URL expired: the history should be read again for a new one. */
  readonly onExpired?: (() => void) | undefined;
}

/**
 * The photos on one message, in rows of two square tiles
 * ([ADR-0067](../../../../docs/decisions/ADR-0067-conversation-photos.md) § 3).
 *
 * The tiles are `flex-1 aspect-square`, the portfolio grid's tile
 * (`MediaGrid.tsx`), so their size comes from the bubble's width and no
 * dimension is invented. A lone last photo keeps its square beside an empty
 * cell rather than stretching across the row; a message with one photo shows
 * it the bubble's full width.
 */
export function MessagePhotoGrid({
  photos,
  mine,
  onExpired,
}: MessagePhotoGridProps): React.JSX.Element {
  const rows: (readonly BubblePhoto[])[] = [];
  for (let at = 0; at < photos.length; at += 2) {
    rows.push(photos.slice(at, at + 2));
  }
  const single = photos.length === 1;

  return (
    <View className="gap-1">
      {rows.map((row) => (
        <View key={row[0]?.key} className="flex-row gap-1">
          {row.map((photo) => (
            <MessagePhoto key={photo.key} photo={photo} mine={mine} onExpired={onExpired} />
          ))}
          {!single && row.length === 1 ? <View className="flex-1" /> : null}
        </View>
      ))}
    </View>
  );
}

interface MessagePhotoProps {
  readonly photo: BubblePhoto;
  readonly mine: boolean;
  readonly onExpired: (() => void) | undefined;
}

/**
 * One tile. A photo that will not load shows the `Image` icon, the fallback
 * ADR-0054 § 6 names for "a photo that did not load". If its URL has expired
 * it asks for the history again, and the new URL is a new `uri`, so the tile
 * tries once more rather than keeping the fallback: the failure is remembered
 * against the URL, as `PortfolioPhoto` does.
 */
function MessagePhoto({ photo, mine, onExpired }: MessagePhotoProps): React.JSX.Element {
  const [failedUri, setFailedUri] = useState<string | null>(null);

  if (failedUri === photo.uri) {
    return (
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={copy.photoFailed}
        className="aspect-square flex-1 items-center justify-center rounded-sm"
      >
        <ImageIcon size="lg" tone={mine ? 'on-inverse' : 'text-muted'} />
      </View>
    );
  }

  return (
    <Image
      testID="message-photo"
      source={{ uri: photo.uri }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={copy.photo}
      accessibilityIgnoresInvertColors
      className="aspect-square flex-1 rounded-sm"
      onError={() => {
        setFailedUri(photo.uri);
        if (
          photo.expiresAt !== undefined &&
          Date.parse(photo.expiresAt) - EXPIRY_MARGIN_MS <= Date.now()
        ) {
          onExpired?.();
        }
      }}
    />
  );
}
