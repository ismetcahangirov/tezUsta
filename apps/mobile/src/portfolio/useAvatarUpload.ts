import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api/api-slice';
import { discardCachedFile } from '../lib/cached-files';
import { preparePhoto } from '../lib/prepare-photo';
import { useAppDispatch } from '../store/hooks';
import {
  useConfirmAvatarMutation,
  useLazyAvatarUploadQuery,
  usePresignAvatarMutation,
  useRemoveAvatarMutation,
  UPLOAD_CONTENT_TYPE,
} from './portfolio-endpoints';
import { putWithProgress } from './put-with-progress';

/** How often, and how many times, a new avatar's processing is asked about. */
export const AVATAR_POLL_INTERVAL_MS = 3_000;
export const AVATAR_POLL_ATTEMPTS = 20;

export type AvatarPhase = 'idle' | 'working' | 'failed';

export interface AvatarUpload {
  /** `working` from the pick until the new renditions exist; `failed` if they never did. */
  readonly phase: AvatarPhase;
  readonly removing: boolean;
  /** The photo library was refused: nothing was picked. */
  readonly permissionDenied: boolean;
  /** Opens the picker with its own square crop, then uploads. */
  change: () => Promise<void>;
  /** Uploads the same photo again after a failure. */
  retry: () => Promise<void>;
  remove: () => Promise<void>;
}

const wait = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The master's avatar (ADR-0054 § 7, #309, #314).
 *
 * **The crop is the system picker's own** (`allowsEditing` with a 1:1 aspect);
 * there is no crop screen of ours. The photo is then prepared like every other
 * (`preparePhoto`), presigned, `PUT` and confirmed.
 *
 * **The old avatar stays until the new one exists**: the server swaps the keys
 * only once the new renditions are made (ADR-0045 § 8). So this waits, asking
 * about the upload every few seconds a bounded number of times, and only then
 * invalidates the master and their profile so both redraw with it. A failure,
 * or no answer within the bound, is `failed`, and `retry` sends the same photo
 * again.
 */
export function useAvatarUpload(): AvatarUpload {
  const dispatch = useAppDispatch();
  const [phase, setPhase] = useState<AvatarPhase>('idle');
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [presign] = usePresignAvatarMutation();
  const [confirm] = useConfirmAvatarMutation();
  const [readUpload] = useLazyAvatarUploadQuery();
  const [removeAvatar, removeResult] = useRemoveAvatarMutation();

  /** The picker's copy, kept for `retry` and deleted once it is not needed (#408). */
  const lastPicked = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      discardCachedFile(lastPicked.current);
      lastPicked.current = null;
    };
  }, []);

  /** Replaces the photo kept for a retry, deleting the one it replaces. */
  const keepForRetry = useCallback((uri: string | null): void => {
    if (lastPicked.current !== uri) {
      discardCachedFile(lastPicked.current);
    }
    lastPicked.current = uri;
  }, []);

  const setIfMounted = useCallback((next: AvatarPhase): void => {
    if (mounted.current) {
      setPhase(next);
    }
  }, []);

  const send = useCallback(
    async (sourceUri: string): Promise<void> => {
      setIfMounted('working');
      let preparedUri: string | null = null;
      try {
        const photo = await preparePhoto(sourceUri);
        preparedUri = photo.uri;
        const presigned = await presign().unwrap();
        await putWithProgress({
          url: presigned.uploadUrl,
          fileUri: photo.uri,
          contentType: UPLOAD_CONTENT_TYPE,
          onProgress: () => undefined,
        });
        let upload = await confirm(presigned.uploadId).unwrap();

        for (
          let attempt = 0;
          attempt < AVATAR_POLL_ATTEMPTS && upload.status !== 'ready' && upload.status !== 'failed';
          attempt += 1
        ) {
          await wait(AVATAR_POLL_INTERVAL_MS);
          if (!mounted.current) {
            return;
          }
          upload = await readUpload(presigned.uploadId, false).unwrap();
        }

        if (upload.status !== 'ready') {
          setIfMounted('failed');
          return;
        }
        keepForRetry(null);
        dispatch(api.util.invalidateTags([{ type: 'OwnMaster', id: 'ME' }, 'MasterProfile']));
        setIfMounted('idle');
      } catch {
        setIfMounted('failed');
      } finally {
        // Read once, for the `PUT`; a retry re-encodes from the picker's copy.
        discardCachedFile(preparedUri);
      }
    },
    [confirm, dispatch, keepForRetry, presign, readUpload, setIfMounted],
  );

  const change = useCallback(async (): Promise<void> => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    setPermissionDenied(!permission.granted);
    if (!permission.granted) {
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      exif: false,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (asset === undefined) {
      return;
    }
    keepForRetry(asset.uri);
    await send(asset.uri);
  }, [keepForRetry, send]);

  const retry = useCallback(async (): Promise<void> => {
    if (lastPicked.current === null) {
      await change();
      return;
    }
    await send(lastPicked.current);
  }, [change, send]);

  const remove = useCallback(async (): Promise<void> => {
    await removeAvatar()
      .unwrap()
      .catch(() => undefined);
  }, [removeAvatar]);

  return { phase, removing: removeResult.isLoading, permissionDenied, change, retry, remove };
}
