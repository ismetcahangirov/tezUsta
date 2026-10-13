import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

/**
 * The longest edge a photo is uploaded at. A 12 MP camera photo (4032×3024)
 * comes down to 2560×1920: plenty for a master to see the problem, and about
 * a megabyte instead of four to six (#319). Mobile data costs money in this
 * market.
 */
export const PHOTO_MAX_EDGE_PX = 2560;

/** JPEG quality for an uploaded photo, from #314's spec. */
export const PHOTO_JPEG_QUALITY = 0.85;

/** What a picked photo has to say about itself. `expo-image-picker`'s asset fits. */
export interface PhotoSource {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
}

/** A photo ready to upload: always a JPEG in the app's cache directory. */
export interface PreparedPhoto {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly mimeType: 'image/jpeg';
}

/**
 * Re-encodes a picked photo as a JPEG, its long edge capped at
 * {@link PHOTO_MAX_EDGE_PX}, before it is uploaded.
 *
 * **Every photo, not only the ones the server would refuse.** The iPhone
 * camera saves HEIC by default and `expo-image-picker` hands it over raw. The
 * server's allow-list is JPEG, PNG and WebP, and it stays that way, because
 * prebuilt `sharp` cannot decode HEIC. Converting everything here also gives
 * every photo the same size budget, whatever the camera.
 *
 * One helper for every upload of a photo: an order's photos now and a
 * master's portfolio (#314) next. Throws if the image cannot be decoded; a
 * caller treats that as a failed upload.
 */
export async function preparePhoto(source: PhotoSource): Promise<PreparedPhoto> {
  const context = ImageManipulator.manipulate(source.uri);
  const longEdge = Math.max(source.width, source.height);
  if (longEdge > PHOTO_MAX_EDGE_PX) {
    // One side is enough: the other follows from the aspect ratio.
    context.resize(
      source.width >= source.height ? { width: PHOTO_MAX_EDGE_PX } : { height: PHOTO_MAX_EDGE_PX },
    );
  }
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: PHOTO_JPEG_QUALITY });
  return { uri: saved.uri, width: saved.width, height: saved.height, mimeType: 'image/jpeg' };
}
