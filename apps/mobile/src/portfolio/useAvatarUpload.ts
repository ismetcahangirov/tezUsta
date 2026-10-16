import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api/api-slice';
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

  const lastPicked = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setIfMounted = useCallback((next: AvatarPhase): void => {
    if (mounted.current) {
      setPhase(next);
    }
  }, []);

  const send = useCallback(
    async (sourceUri: string): Promise<void> => {
      setIfMounted('working');
      try {
        const photo = await preparePhoto(sourceUri);
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
        lastPicked.current = null;
        dispatch(api.util.invalidateTags([{ type: 'OwnMaster', id: 'ME' }, 'MasterProfile']));
        setIfMounted('idle');
      } catch {
        setIfMounted('failed');
      }
    },
    [confirm, dispatch, presign, readUpload, setIfMounted],
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
    lastPicked.current = asset.uri;
    await send(asset.uri);
  }, [send]);

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
