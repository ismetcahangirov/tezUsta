import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useRef, useState } from 'react';

import { discardCachedFile } from '../lib/cached-files';
import { preparePhoto } from '../lib/prepare-photo';
import {
  MAX_PHOTOS_PER_MESSAGE,
  useConfirmMessagePhotoMutation,
  usePresignMessagePhotoMutation,
} from './conversation-endpoints';
import type { OutboxPhoto } from './outbox-slice';

/** One photo waiting in the composer, and how far it has got. */
export interface DraftPhoto {
  readonly localId: string;
  /** What the strip draws: the picked file until it is prepared, then the prepared JPEG. */
  readonly uri: string;
  readonly status: 'uploading' | 'ready' | 'failed';
}

export interface MessagePhotos {
  readonly photos: readonly DraftPhoto[];
  readonly isPicking: boolean;
  readonly permissionDenied: boolean;
  /** Room for another photo on this message. */
  readonly canAdd: boolean;
  /** Every photo uploaded and confirmed: a send may carry them. */
  readonly ready: boolean;
  pick: () => Promise<void>;
  remove: (localId: string) => void;
  /**
   * Hands the uploaded photos to a send and empties the strip. Their files go
   * with them: the send deletes them once the message settles.
   */
  take: () => readonly OutboxPhoto[];
}

/** What only the hook needs about a photo; never rendered. */
interface Tracked {
  sourceUri: string | null;
  preparedUri: string | null;
  attachmentId: string | null;
  removed: boolean;
}

/**
 * Choosing photos for the next message, and getting them into storage
 * (#456, [ADR-0067](../../../../docs/decisions/ADR-0067-conversation-photos.md)).
 * The order-photo flow (`useOrderPhotos`) against the conversation's routes.
 *
 * - **Every photo is re-encoded first** (`preparePhoto`): a JPEG with its long
 *   edge capped. That is what lets an iPhone's HEIC through (#319).
 * - **One upload at a time.** The server keeps a single outstanding presign
 *   per side of a conversation and clears the previous one when asked for
 *   another, so a second upload started alongside the first would cancel it.
 *   Photos picked together, or picked again while one is uploading, wait in
 *   one queue.
 * - **A failure is one photo's.** It stays in the strip as failed until it is
 *   removed; nothing retries on its own. A photo removed mid-upload finishes
 *   nowhere: its confirmed row is never named on a message, and the server
 *   sweeps it.
 *
 * **Local files are deleted once nothing needs them** (#408). The picker's
 * copy goes as soon as the prepared JPEG exists, which replaces it as the
 * preview. The JPEG goes with its row, or, once `take` hands it to a send,
 * when that message settles.
 */
export function useMessagePhotos(orderId: string): MessagePhotos {
  const [photos, setPhotos] = useState<readonly DraftPhoto[]>([]);
  const [isPicking, setIsPicking] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [presign] = usePresignMessagePhotoMutation();
  const [confirm] = useConfirmMessagePhotoMutation();

  const tracked = useRef(new Map<string, Tracked>());
  const queue = useRef<string[]>([]);
  const running = useRef(false);
  const nextLocalId = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const rows = tracked.current;
    return () => {
      mounted.current = false;
      for (const row of rows.values()) {
        row.removed = true;
        release(row);
      }
      rows.clear();
    };
  }, []);

  const update = useCallback((localId: string, patch: Partial<DraftPhoto>): void => {
    if (!mounted.current) {
      return;
    }
    setPhotos((current) =>
      current.map((photo) => (photo.localId === localId ? { ...photo, ...patch } : photo)),
    );
  }, []);

  const upload = useCallback(
    async (localId: string): Promise<void> => {
      const row = tracked.current.get(localId);
      if (row === undefined || row.removed || row.sourceUri === null) {
        return;
      }
      try {
        const prepared = await preparePhoto(row.sourceUri);
        row.preparedUri = prepared.uri;
        discardCachedFile(row.sourceUri);
        row.sourceUri = null;
        if (row.removed) {
          release(row);
          return;
        }
        update(localId, { uri: prepared.uri });

        const presigned = await presign({ orderId, contentType: prepared.mimeType }).unwrap();
        // Bytes through the file system, not `fetch(file://…)` and not a Blob,
        // for the reasons `useOrderPhotos` gives (#379).
        const bytes = new Uint8Array(await new File(prepared.uri).arrayBuffer());
        const put = await fetch(presigned.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': prepared.mimeType },
          body: bytes,
        });
        if (!put.ok) {
          throw new Error('upload rejected');
        }
        await confirm({ orderId, attachmentId: presigned.attachmentId }).unwrap();
        row.attachmentId = presigned.attachmentId;
        update(localId, { status: 'ready' });
      } catch {
        update(localId, { status: 'failed' });
      }
    },
    [confirm, orderId, presign, update],
  );

  const drain = useCallback(async (): Promise<void> => {
    if (running.current) {
      return;
    }
    running.current = true;
    try {
      for (let next = queue.current.shift(); next !== undefined; next = queue.current.shift()) {
        if (!mounted.current) {
          return;
        }
        await upload(next);
      }
    } finally {
      running.current = false;
    }
  }, [upload]);

  async function pick(): Promise<void> {
    const room = MAX_PHOTOS_PER_MESSAGE - photos.length;
    if (room <= 0 || isPicking) {
      return;
    }

    setIsPicking(true);
    try {
      // Asked at the moment of need, as for an order's photos; a denial
      // leaves the text composer working.
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setPermissionDenied(true);
        return;
      }
      setPermissionDenied(false);

      // `exif: false` keeps the photo's EXIF, GPS included, out of JavaScript
      // (#318); the re-encode strips the file itself.
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        exif: false,
        allowsMultipleSelection: room > 1,
        selectionLimit: room,
      });
      if (result.canceled || !mounted.current) {
        return;
      }

      const added = result.assets.slice(0, room).map((asset) => {
        nextLocalId.current += 1;
        const localId = `photo-${String(nextLocalId.current)}`;
        tracked.current.set(localId, {
          sourceUri: asset.uri,
          preparedUri: null,
          attachmentId: null,
          removed: false,
        });
        queue.current.push(localId);
        return { localId, uri: asset.uri, status: 'uploading' as const };
      });
      setPhotos((current) => [...current, ...added]);
      void drain();
    } finally {
      if (mounted.current) {
        setIsPicking(false);
      }
    }
  }

  function remove(localId: string): void {
    setPhotos((current) => current.filter((photo) => photo.localId !== localId));
    queue.current = queue.current.filter((queued) => queued !== localId);
    const row = tracked.current.get(localId);
    if (row !== undefined) {
      row.removed = true;
      release(row);
      tracked.current.delete(localId);
    }
  }

  function take(): readonly OutboxPhoto[] {
    const taken = photos.flatMap((photo) => {
      const row = tracked.current.get(photo.localId);
      if (
        photo.status !== 'ready' ||
        row === undefined ||
        row.attachmentId === null ||
        row.preparedUri === null
      ) {
        return [];
      }
      tracked.current.delete(photo.localId);
      return [{ attachmentId: row.attachmentId, uri: row.preparedUri }];
    });
    for (const photo of photos) {
      remove(photo.localId);
    }
    return taken;
  }

  return {
    photos,
    isPicking,
    permissionDenied,
    canAdd: photos.length < MAX_PHOTOS_PER_MESSAGE,
    ready: photos.every((photo) => photo.status === 'ready'),
    pick,
    remove,
    take,
  };
}

/** Deletes a row's files. Idempotent, like `discardCachedFile`. */
function release(row: Tracked): void {
  discardCachedFile(row.sourceUri);
  discardCachedFile(row.preparedUri);
  row.sourceUri = null;
  row.preparedUri = null;
}
