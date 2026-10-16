import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useRef, useState } from 'react';

import { preparePhoto } from '../lib/prepare-photo';
import {
  useConfirmMediaMutation,
  useCreatePostMutation,
  useDeleteMediaMutation,
  useDeletePostMutation,
  useLazyOwnPostQuery,
  usePresignMediaMutation,
  UPLOAD_CONTENT_TYPE,
} from './portfolio-endpoints';
import { isAbortError, putWithProgress } from './put-with-progress';

/**
 * How many photos a post holds. Mirrors the server's default
 * `PORTFOLIO_MAX_ITEMS_PER_POST`, which it enforces, positions included
 * (0 to 9); this only stops the picker offering more than will fit.
 */
export const PORTFOLIO_MAX_ITEMS_PER_POST = 10;

/** How many photos upload at once (#314): two keeps a slow line busy without queuing it. */
export const UPLOAD_CONCURRENCY = 2;

/** A presigned URL this close to expiring is not reused for a retry. */
const URL_EXPIRY_MARGIN_MS = 30_000;

export type UploadStatus = 'preparing' | 'uploading' | 'uploaded' | 'failed';

/** One photo the master chose, and how far it has got. */
export interface UploadItem {
  readonly localId: string;
  /** What the strip draws: the picked file until it is prepared, then the prepared JPEG. */
  readonly previewUri: string;
  readonly status: UploadStatus;
  /** 0 to 1 while uploading. */
  readonly progress: number;
}

export interface PortfolioUpload {
  /** The draft the photos belong to, once the first one has been chosen. */
  readonly postId: string | null;
  readonly items: readonly UploadItem[];
  readonly isPicking: boolean;
  readonly permissionDenied: boolean;
  /** At least one photo, and every photo uploaded: the post may be published. */
  readonly ready: boolean;
  pick: () => Promise<void>;
  retry: (localId: string) => void;
  remove: (localId: string) => void;
  /** Abandons the draft: stops every upload and deletes the post. */
  discard: () => Promise<void>;
  /**
   * Brings the server's draft back in line with the photos on screen, after a
   * publish was refused for a photo that never arrived: deletes the draft's
   * photos this editor no longer holds. Resolves true when it changed anything.
   */
  reconcile: () => Promise<boolean>;
}

/** What only the hook needs about an item; never rendered. */
interface Tracked {
  /** Where the photo sits in the post: fixed when it is picked, so the order chosen is kept. */
  readonly position: number;
  /** The picked file, kept only until its photo has uploaded. */
  sourceUri: string | null;
  /** The prepared JPEG, kept with the presign so a retry can send it again. */
  preparedUri: string | null;
  presigned: { mediaId: string; uploadUrl: string; expiresAt: number } | null;
  abort: AbortController | null;
  removed: boolean;
}

/**
 * Choosing photos for a new post and getting them into storage (#314,
 * ADR-0054 § 5), the order-photo flow (`useOrderPhotos`) grown up.
 *
 * - **Several at once:** the system picker with multiple selection, up to the
 *   room left in the post. Images only: ADR-0045 § 7 defers video.
 * - **Every photo is re-encoded first** (`preparePhoto`): a JPEG, its long edge
 *   capped at 2560 px. That is what lets an iPhone's HEIC through and what
 *   keeps a 12 MP photo near a megabyte, on data the master pays for.
 * - **Two upload at a time**, from one queue however many times the picker is
 *   opened. Each is presigned, `PUT` with progress, then confirmed, which is
 *   where the server checks the real bytes.
 * - **A photo's place is fixed when it is picked**: the lowest position the
 *   post has free, so the post keeps the order chosen however long each photo
 *   takes to prepare. A position is free again only once its server row is
 *   gone.
 * - **A failure is one photo's**: a retry sends the same file to the same URL
 *   while it is valid (the server keeps a refused photo for exactly that), and
 *   otherwise frees the row and presigns the same position again. Removing a
 *   photo stops it and deletes its row, even one presigned after the removal.
 *
 * **The draft is created with the first photo**, not when the editor opens, so
 * a master who opens it and leaves creates nothing. `discard` deletes it, and
 * after a discard or once the editor is gone nothing creates another. A draft
 * left behind by a killed app is swept by the server (#311).
 *
 * **A local file is held only until its photo has uploaded**: the OS may
 * reclaim the cache, and nothing after the upload needs it.
 */
export function usePortfolioUpload(maxItems = PORTFOLIO_MAX_ITEMS_PER_POST): PortfolioUpload {
  const [items, setItems] = useState<readonly UploadItem[]>([]);
  const [postId, setPostId] = useState<string | null>(null);
  const [isPicking, setIsPicking] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const [createPost] = useCreatePostMutation();
  const [presignMedia] = usePresignMediaMutation();
  const [confirmMedia] = useConfirmMediaMutation();
  const [deleteMedia] = useDeleteMediaMutation();
  const [deletePost] = useDeletePostMutation();
  const [readPost] = useLazyOwnPostQuery();

  const tracked = useRef(new Map<string, Tracked>());
  /** Positions whose server row may still exist: an item's, or one being deleted. */
  const heldPositions = useRef(new Set<number>());
  const draft = useRef<Promise<string> | null>(null);
  const draftId = useRef<string | null>(null);
  const queue = useRef<string[]>([]);
  const running = useRef(0);
  const nextLocalId = useRef(0);
  /** Set by `discard` and on unmount: nothing may start, and no draft may be created. */
  const closed = useRef(false);

  useEffect(() => {
    closed.current = false;
    const uploads = tracked.current;
    return () => {
      closed.current = true;
      // Leaving stops the bytes; the draft itself is swept server-side.
      for (const item of uploads.values()) {
        item.abort?.abort();
      }
    };
  }, []);

  const update = useCallback((localId: string, patch: Partial<UploadItem>): void => {
    if (closed.current) {
      return;
    }
    setItems((current) =>
      current.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
    );
  }, []);

  /** The draft's id, creating it on first use. One request however many photos ask. */
  const ensureDraft = useCallback(async (): Promise<string> => {
    if (closed.current) {
      throw abortedError();
    }
    draft.current ??= createPost({})
      .unwrap()
      .then((post) => {
        draftId.current = post.id;
        if (!closed.current) {
          setPostId(post.id);
        }
        return post.id;
      })
      .catch((error: unknown) => {
        draft.current = null;
        throw error;
      });
    return draft.current;
  }, [createPost]);

  /** Deletes a photo's row and only then frees its position. A failure keeps it held. */
  const dropRow = useCallback(
    async (position: number, mediaId: string | null): Promise<void> => {
      const id = draftId.current;
      if (mediaId === null || id === null) {
        heldPositions.current.delete(position);
        return;
      }
      try {
        await deleteMedia({ postId: id, mediaId }).unwrap();
        heldPositions.current.delete(position);
      } catch {
        // Held until a reconcile frees it; the post has room to spare otherwise.
      }
    },
    [deleteMedia],
  );

  /** One photo, from the picked file to a confirmed upload. */
  const upload = useCallback(
    async (localId: string): Promise<void> => {
      const entry = tracked.current.get(localId);
      if (entry === undefined || entry.removed || closed.current) {
        return;
      }
      const abort = new AbortController();
      entry.abort = abort;
      const stopped = (): boolean => abort.signal.aborted || entry.removed || closed.current;
      // Removed before anything was presigned: its position is free at once.
      const leaveUnsigned = (): void => {
        if (entry.removed && entry.presigned === null) {
          heldPositions.current.delete(entry.position);
        }
      };

      try {
        if (entry.preparedUri === null) {
          update(localId, { status: 'preparing', progress: 0 });
          if (entry.sourceUri === null) {
            return;
          }
          const photo = await preparePhoto(entry.sourceUri);
          entry.preparedUri = photo.uri;
          update(localId, { previewUri: photo.uri });
          if (stopped()) {
            leaveUnsigned();
            return;
          }
        }

        const id = await ensureDraft();
        if (stopped()) {
          leaveUnsigned();
          return;
        }

        const reusable =
          entry.presigned !== null && entry.presigned.expiresAt - Date.now() > URL_EXPIRY_MARGIN_MS;
        if (!reusable) {
          if (entry.presigned !== null) {
            // An expired URL: free the row, keep the position for the new one.
            await deleteMedia({ postId: id, mediaId: entry.presigned.mediaId }).unwrap();
            entry.presigned = null;
          }
          const presigned = await presignMedia({ postId: id, position: entry.position }).unwrap();
          entry.presigned = {
            mediaId: presigned.mediaId,
            uploadUrl: presigned.uploadUrl,
            expiresAt: Date.parse(presigned.expiresAt),
          };
          if (stopped()) {
            // Removed while the presign was on its way: the row it made goes too.
            await dropRow(entry.position, presigned.mediaId);
            return;
          }
        }
        const { mediaId, uploadUrl } = entry.presigned!;

        update(localId, { status: 'uploading', progress: 0 });
        await putWithProgress({
          url: uploadUrl,
          fileUri: entry.preparedUri,
          contentType: UPLOAD_CONTENT_TYPE,
          signal: abort.signal,
          onProgress: (progress) => {
            update(localId, { progress });
          },
        });
        await confirmMedia({ postId: id, mediaId }).unwrap();

        entry.sourceUri = null;
        update(localId, { status: 'uploaded', progress: 1 });
      } catch (error) {
        if (!isAbortError(error) && !stopped()) {
          update(localId, { status: 'failed' });
        }
      } finally {
        entry.abort = null;
      }
    },
    [confirmMedia, deleteMedia, dropRow, ensureDraft, presignMedia, update],
  );

  /** Starts queued uploads until `UPLOAD_CONCURRENCY` are running. */
  const pump = useCallback((): void => {
    while (running.current < UPLOAD_CONCURRENCY && queue.current.length > 0) {
      const next = queue.current.shift()!;
      running.current += 1;
      void upload(next).finally(() => {
        running.current -= 1;
        pump();
      });
    }
  }, [upload]);

  const enqueue = useCallback(
    (localIds: readonly string[]): void => {
      queue.current.push(...localIds);
      pump();
    },
    [pump],
  );

  const pick = useCallback(async (): Promise<void> => {
    const free = Array.from({ length: maxItems }, (_, position) => position).filter(
      (position) => !heldPositions.current.has(position),
    );
    const room = Math.min(maxItems - items.length, free.length);
    if (room <= 0 || closed.current) {
      return;
    }

    setIsPicking(true);
    let chosen: ImagePicker.ImagePickerAsset[];
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setPermissionDenied(true);
        return;
      }
      setPermissionDenied(false);

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: room,
        orderedSelection: true,
        exif: false,
      });
      chosen = result.canceled ? [] : result.assets.slice(0, room);
    } finally {
      setIsPicking(false);
    }
    if (chosen.length === 0 || closed.current) {
      return;
    }

    const added = chosen.map((asset, index): UploadItem => {
      nextLocalId.current += 1;
      const localId = `photo-${String(nextLocalId.current)}`;
      const position = free[index]!;
      heldPositions.current.add(position);
      tracked.current.set(localId, {
        position,
        sourceUri: asset.uri,
        preparedUri: null,
        presigned: null,
        abort: null,
        removed: false,
      });
      return { localId, previewUri: asset.uri, status: 'preparing', progress: 0 };
    });
    setItems((current) => [...current, ...added]);
    enqueue(added.map((item) => item.localId));
  }, [enqueue, items.length, maxItems]);

  const retry = useCallback(
    (localId: string): void => {
      if (tracked.current.has(localId)) {
        enqueue([localId]);
      }
    },
    [enqueue],
  );

  const remove = useCallback(
    (localId: string): void => {
      const entry = tracked.current.get(localId);
      tracked.current.delete(localId);
      queue.current = queue.current.filter((queued) => queued !== localId);
      setItems((current) => current.filter((item) => item.localId !== localId));
      if (entry === undefined) {
        return;
      }
      entry.removed = true;
      entry.abort?.abort();
      // A presign still on its way is dropped by the upload itself when it lands.
      if (entry.presigned !== null || entry.abort === null) {
        void dropRow(entry.position, entry.presigned?.mediaId ?? null);
      }
    },
    [dropRow],
  );

  const discard = useCallback(async (): Promise<void> => {
    closed.current = true;
    queue.current = [];
    for (const entry of tracked.current.values()) {
      entry.removed = true;
      entry.abort?.abort();
    }
    tracked.current.clear();
    heldPositions.current.clear();
    setItems([]);
    const id = await draft.current?.catch(() => null);
    if (id !== null && id !== undefined) {
      // A draft the server cannot delete now is swept later (#311).
      await deletePost(id)
        .unwrap()
        .catch(() => undefined);
    }
    draft.current = null;
    draftId.current = null;
    setPostId(null);
  }, [deletePost]);

  const reconcile = useCallback(async (): Promise<boolean> => {
    const id = draftId.current;
    if (id === null) {
      return false;
    }
    const held = new Set(
      [...tracked.current.values()].flatMap((entry) =>
        entry.presigned === null ? [] : [entry.presigned.mediaId],
      ),
    );
    try {
      const server = await readPost(id, false).unwrap();
      const strays = server.media.filter((media) => !held.has(media.id));
      for (const stray of strays) {
        await deleteMedia({ postId: id, mediaId: stray.id }).unwrap();
        heldPositions.current.delete(stray.position);
      }
      return strays.length > 0;
    } catch {
      return false;
    }
  }, [deleteMedia, readPost]);

  const ready = items.length > 0 && items.every((item) => item.status === 'uploaded');

  return {
    postId,
    items,
    isPicking,
    permissionDenied,
    ready,
    pick,
    retry,
    remove,
    discard,
    reconcile,
  };
}

/** The error an upload stops with once the editor has been closed or the draft abandoned. */
function abortedError(): Error {
  const error = new Error('editor closed');
  error.name = 'AbortError';
  return error;
}
