import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

/**
 * The longest edge a photo is uploaded at. A 12 MP camera photo (4032×3024)
 * comes down to 2560×1920: plenty for a master to see the problem. The aim is
 * about a megabyte rather than four to six (#319), because mobile data costs
 * money in this market.
 */
export const PHOTO_MAX_EDGE_PX = 2560;

/** JPEG quality for an uploaded photo, from #314's spec. */
export const PHOTO_JPEG_QUALITY = 0.85;

/** A photo ready to upload: always a JPEG in the app's cache directory. */
export interface PreparedPhoto {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly mimeType: 'image/jpeg';
}

/** The release every native object from the manipulator has. */
interface Releasable {
  release(): void;
}

/**
 * Re-encodes a picked photo as a JPEG, its long edge capped at
 * {@link PHOTO_MAX_EDGE_PX}, before it is uploaded.
 *
 * **Every photo, not only the ones the server would refuse.** The iPhone
 * camera saves HEIC by default and `expo-image-picker` hands it over raw. The
 * server's allow-list is JPEG, PNG and WebP, and it stays that way, because
 * prebuilt `sharp` cannot decode HEIC. Converting everything here also gives
 * every photo the same size budget, whatever the camera. The cost: JPEG has
 * no transparency, so a transparent PNG comes out on black.
 *
 * **The size is read from the decoded image**, not from the picker, which may
 * report 0 when the platform did not say.
 *
 * **Native memory is released as soon as the file is written.** A decoded
 * 2560×1920 bitmap is about 20 MB, and waiting for garbage collection to free
 * it, once per photo, is a real cost on a mid-range Android phone. Expo's own
 * `manipulateAsync` releases the same way.
 *
 * One helper for every upload of a photo: an order's photos now, and a
 * master's portfolio (#314) once it is built. Throws if the image cannot be
 * decoded; a caller treats that as a failed upload.
 */
export async function preparePhoto(uri: string): Promise<PreparedPhoto> {
  const held: Releasable[] = [];
  try {
    const decoding = ImageManipulator.manipulate(uri);
    held.push(decoding);
    let image = await decoding.renderAsync();
    held.push(image);

    if (Math.max(image.width, image.height) > PHOTO_MAX_EDGE_PX) {
      // One side is enough: the other follows from the aspect ratio.
      const resizing = ImageManipulator.manipulate(image).resize(
        image.width >= image.height ? { width: PHOTO_MAX_EDGE_PX } : { height: PHOTO_MAX_EDGE_PX },
      );
      held.push(resizing);
      image = await resizing.renderAsync();
      held.push(image);
    }

    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: PHOTO_JPEG_QUALITY });
    return { uri: saved.uri, width: saved.width, height: saved.height, mimeType: 'image/jpeg' };
  } finally {
    for (const object of held) {
      object.release();
    }
  }
}
