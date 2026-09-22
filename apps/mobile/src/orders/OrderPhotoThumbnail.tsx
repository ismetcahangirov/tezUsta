import { Image } from 'react-native';

import { Skeleton, Text } from '../components';
import { useOrderPhotoDownloadQuery } from './order-endpoints';
import { ORDERS_COPY as copy } from './orders-copy';

export interface OrderPhotoThumbnailProps {
  readonly orderId: string;
  readonly photoId: string;
}

/**
 * One attached photo, fetching its own short-lived URL.
 *
 * **A component per photo rather than a loop of hooks**, which is what makes
 * the per-photo request legal at all: a hook cannot be called in a loop, and a
 * child that owns its own query can be. It is also what keeps one photo's
 * failure to one photo — a presigned URL that could not be minted leaves a
 * caption where an image would be, and the rest of the screen is untouched.
 *
 * The URL is never cached (`keepUnusedDataFor: 0` on the endpoint): it expires
 * within minutes, and a cached dead link renders as a broken image rather than
 * as something the screen knows to ask for again
 * ([ADR-0005](docs/decisions/ADR-0005-object-storage.md)).
 *
 * **No tap target.** A full-screen viewer is a component the inventory does not
 * have, and adding one here would be inventing a visual pattern rather than
 * using the settled ones (CLAUDE.md §17,
 * [ADR-0029](docs/decisions/ADR-0029-customer-order-screen.md)).
 */
export function OrderPhotoThumbnail({
  orderId,
  photoId,
}: OrderPhotoThumbnailProps): React.JSX.Element {
  const download = useOrderPhotoDownloadQuery({ orderId, photoId });

  if (download.currentData === undefined) {
    return download.error === undefined ? (
      <Skeleton className="size-20 rounded-md" />
    ) : (
      <Text variant="caption" tone="muted" className="w-20">
        {copy.detail.photoFailed}
      </Text>
    );
  }

  return (
    <Image
      source={{ uri: download.currentData.url }}
      accessibilityIgnoresInvertColors
      className="size-20 rounded-md"
    />
  );
}
