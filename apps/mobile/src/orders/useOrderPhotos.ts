import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';

import { useConfirmOrderPhotoMutation, usePresignOrderPhotoMutation } from './order-endpoints';

/**
 * One photo the customer has chosen, and how far it has got.
 *
 * `uri` is the local file the picker returned — kept only so the thumbnail can
 * be drawn. It is never sent anywhere: the bytes go straight to object storage
 * through the presigned URL, and the server is told nothing but the photo id.
 */
export interface PendingPhoto {
  readonly localId: string;
  readonly uri: string;
  readonly photoId: string | null;
  readonly status: 'uploading' | 'ready' | 'failed';
}

export interface OrderPhotos {
  readonly photos: readonly PendingPhoto[];
  readonly isPicking: boolean;
  readonly permissionDenied: boolean;
  pick: () => Promise<void>;
  remove: (localId: string) => void;
  /** The ids that actually made it, for attaching once the order exists. */
  readyPhotoIds: () => readonly string[];
}

/** The content types the server will sign. An allow-list, matching its own. */
const ALLOWED: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function contentTypeFor(uri: string, mimeType: string | undefined): string | null {
  if (mimeType !== undefined && Object.values(ALLOWED).includes(mimeType)) {
    return mimeType;
  }
  const extension = uri.split('.').pop()?.toLowerCase();
  return extension === undefined ? null : (ALLOWED[extension] ?? null);
}

/**
 * Picking a photo, and getting its bytes into object storage.
 *
 * **Three server round trips and one that does not touch the server at all.**
 * Presign asks for a URL, the `PUT` goes straight to storage, and confirm is
 * where the server validates the real object — its size against `head()`, its
 * leading bytes against an allow-list. The API never receives an image
 * ([ADR-0005](docs/decisions/ADR-0005-object-storage.md)).
 *
 * **A failure here is never fatal to the order.** `docs/product/customer-flow.md`
 * is explicit: if the upload fails, the order can still be created without it.
 * So a failed photo becomes a row the customer can remove and the submit
 * button stays available — it does not block, and it does not retry itself.
 *
 * Attaching is deliberately *not* here: a photo can only be attached to an
 * order that exists, and the order does not exist until the customer submits.
 */
export function useOrderPhotos(maxPhotos: number): OrderPhotos {
  const [photos, setPhotos] = useState<readonly PendingPhoto[]>([]);
  const [isPicking, setIsPicking] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [presign] = usePresignOrderPhotoMutation();
  const [confirm] = useConfirmOrderPhotoMutation();

  function update(localId: string, patch: Partial<PendingPhoto>): void {
    setPhotos((current) =>
      current.map((photo) => (photo.localId === localId ? { ...photo, ...patch } : photo)),
    );
  }

  async function pick(): Promise<void> {
    if (photos.length >= maxPhotos) {
      return;
    }

    setIsPicking(true);
    try {
      // Requested at the time of need, with the flow visible behind it, rather
      // than on first launch (`docs/product/customer-flow.md`). A denial leaves
      // everything else in the flow working.
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setPermissionDenied(true);
        return;
      }
      setPermissionDenied(false);

      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
      const asset = result.canceled ? undefined : result.assets[0];
      if (asset === undefined) {
        return;
      }

      const contentType = contentTypeFor(asset.uri, asset.mimeType);
      if (contentType === null) {
        // Refused here rather than at presign: the server's allow-list would
        // reject it anyway, and failing locally costs the customer nothing and
        // the bucket nothing.
        setPhotos((current) => [
          ...current,
          { localId: asset.uri, uri: asset.uri, photoId: null, status: 'failed' },
        ]);
        return;
      }

      const localId = asset.uri;
      setPhotos((current) => [
        ...current,
        { localId, uri: asset.uri, photoId: null, status: 'uploading' },
      ]);

      try {
        const upload = await presign(contentType).unwrap();
        const bytes = await fetch(asset.uri).then(async (response) => response.blob());
        const put = await fetch(upload.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': contentType },
          body: bytes,
        });
        if (!put.ok) {
          throw new Error('upload rejected');
        }
        await confirm(upload.photoId).unwrap();
        update(localId, { photoId: upload.photoId, status: 'ready' });
      } catch {
        // Deliberately swallowed into row state. The customer sees one failed
        // thumbnail they can remove, and the order remains creatable.
        update(localId, { status: 'failed' });
      }
    } finally {
      setIsPicking(false);
    }
  }

  function remove(localId: string): void {
    setPhotos((current) => current.filter((photo) => photo.localId !== localId));
  }

  function readyPhotoIds(): readonly string[] {
    return photos.flatMap((photo) =>
      photo.status === 'ready' && photo.photoId !== null ? [photo.photoId] : [],
    );
  }

  return { photos, isPicking, permissionDenied, pick, remove, readyPhotoIds };
}
