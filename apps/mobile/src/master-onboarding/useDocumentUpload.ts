import type { MasterDocumentType } from '@tezusta/types';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useRef, useState } from 'react';

import { discardCachedFile } from '../lib/cached-files';
import { preparePhoto } from '../lib/prepare-photo';
import { putWithProgress } from '../portfolio/put-with-progress';

import {
  useConfirmDocumentMutation,
  usePresignDocumentMutation,
} from './master-onboarding-endpoints';

/** Every prepared photo is a JPEG (`preparePhoto`), so that is what is signed. */
const DOCUMENT_CONTENT_TYPE = 'image/jpeg';

export type DocumentUploadPhase = 'idle' | 'uploading' | 'failed';

export interface DocumentUpload {
  readonly phase: DocumentUploadPhase;
  /** 0–1 while `uploading`. */
  readonly progress: number;
  /** The photo library was refused: nothing was picked. */
  readonly permissionDenied: boolean;
  /** Opens the photo library, then uploads the pick. */
  pick: () => Promise<void>;
  /** Sends the same photo again after a failure. */
  retry: () => Promise<void>;
}

/**
 * One verification document: pick, prepare, presign, `PUT`, confirm (#490).
 *
 * The path is ADR-0024's and the steps are `useAvatarUpload`'s, minus the
 * processing poll — a document has no renditions, and the confirm is where the
 * server reads the real bytes. A confirmed upload replaces the previous live
 * document of the same type on the server, which is how a rejected photo is
 * fixed.
 *
 * **The photo library only, for now.** The app is built with
 * `cameraPermission: false` (`app.config.js`), so opening the camera needs a
 * new native build; ADR-0073 records that as the follow-up. A photo taken
 * with the phone's camera app is picked from the library like any other.
 *
 * **Not cropped**: an ID card photographed at an angle is still readable, and
 * a crop the person gets wrong could cut off the very field an admin needs.
 */
export function useDocumentUpload(documentType: MasterDocumentType): DocumentUpload {
  const [phase, setPhase] = useState<DocumentUploadPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [presign] = usePresignDocumentMutation();
  const [confirm] = useConfirmDocumentMutation();

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

  const keepForRetry = useCallback((uri: string | null): void => {
    if (lastPicked.current !== uri) {
      discardCachedFile(lastPicked.current);
    }
    lastPicked.current = uri;
  }, []);

  const send = useCallback(
    async (sourceUri: string): Promise<void> => {
      if (mounted.current) {
        setPhase('uploading');
        setProgress(0);
      }
      let preparedUri: string | null = null;
      try {
        const photo = await preparePhoto(sourceUri);
        preparedUri = photo.uri;
        const presigned = await presign({
          documentType,
          contentType: DOCUMENT_CONTENT_TYPE,
        }).unwrap();
        await putWithProgress({
          url: presigned.uploadUrl,
          fileUri: photo.uri,
          contentType: DOCUMENT_CONTENT_TYPE,
          onProgress: (fraction) => {
            if (mounted.current) setProgress(fraction);
          },
        });
        await confirm(presigned.documentId).unwrap();
        keepForRetry(null);
        if (mounted.current) setPhase('idle');
      } catch {
        if (mounted.current) setPhase('failed');
      } finally {
        // Read once, for the `PUT`; a retry re-encodes from the picker's copy.
        discardCachedFile(preparedUri);
      }
    },
    [confirm, documentType, keepForRetry, presign],
  );

  const pick = useCallback(async (): Promise<void> => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    setPermissionDenied(!permission.granted);
    if (!permission.granted) {
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
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
      await pick();
      return;
    }
    await send(lastPicked.current);
  }, [pick, send]);

  return { phase, progress, permissionDenied, pick, retry };
}
