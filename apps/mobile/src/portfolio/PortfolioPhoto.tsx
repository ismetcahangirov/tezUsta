import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ImageIcon } from '../components';
import { cn } from '../lib/cn';
import type { ColorRole } from '../theme';
import { PORTFOLIO_COPY as copy } from './portfolio-copy';

export interface PortfolioPhotoProps {
  /** A public rendition URL (#304): immutable, so the disk cache stays valid. */
  readonly uri: string;
  /** `cover` crops to the tile; `contain` shows the whole photo (ADR-0054 § 2, § 3). */
  readonly contentFit: 'cover' | 'contain';
  /** The fallback icon's colour: `text-muted` on the page, `on-inverse` on the viewer. */
  readonly fallbackTone: ColorRole;
  /** Sizes the frame; the photo fills it. */
  readonly className?: string;
}

/**
 * One portfolio photo through `expo-image`, or the `Image` icon when it does
 * not load (ADR-0054 § 6 names that icon for "a photo that did not load").
 *
 * **The URL is passed as it came from the API.** `expo-image` caches by URL,
 * and the renditions are immutable public objects, so a query string that
 * changed between renders would only defeat the cache (#313).
 *
 * `recyclingKey` is the URL too. `FlatList` unmounts its cells rather than
 * reusing them, so today it changes nothing; under a recycling list
 * (`FlashList`, should #317's measurements call for one) it makes a reused view
 * clear the previous photo instead of showing it until the next one arrives.
 * The failure is remembered against the URL for the same reason: a view handed
 * a different photo tries again instead of keeping the last one's fallback.
 *
 * **No transition.** `expo-image` draws none unless asked, and a fade is
 * motion, which stays the owner's (CLAUDE.md §17).
 */
export function PortfolioPhoto({
  uri,
  contentFit,
  fallbackTone,
  className,
}: PortfolioPhotoProps): React.JSX.Element {
  const [failedUri, setFailedUri] = useState<string | null>(null);

  return (
    <View className={cn('overflow-hidden', className)}>
      {failedUri === uri ? (
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={copy.photoFailed}
          className="flex-1 items-center justify-center"
        >
          <ImageIcon size="lg" tone={fallbackTone} />
        </View>
      ) : (
        <Image
          testID="portfolio-photo"
          source={{ uri }}
          recyclingKey={uri}
          contentFit={contentFit}
          accessibilityIgnoresInvertColors
          style={StyleSheet.absoluteFill}
          onError={() => {
            setFailedUri(uri);
          }}
        />
      )}
    </View>
  );
}
