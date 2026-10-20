import { File, Paths } from 'expo-file-system';

/**
 * Deletes a photo the app wrote into its own cache once nothing needs it
 * (issue #408): the JPEG `preparePhoto` re-encodes before every upload, and
 * the copy the image picker makes of the photo it was given.
 *
 * **Why bother, when the OS may reclaim the cache?** It may, not must. Until
 * then, a picture of the inside of somebody's home sits in a directory a
 * device backup or anyone holding the unlocked phone can read
 * (`docs/engineering/security.md` § PII and privacy).
 *
 * **Only inside the app's cache directory.** A picker on some platform could
 * hand back a URI in the user's gallery or documents, and deleting that would
 * destroy the user's own photo. Anything outside `Paths.cache` is left alone.
 *
 * **Never throws, and is idempotent.** A file already gone, or a delete the
 * platform refuses, is not worth failing an upload or an unmount for.
 */
export function discardCachedFile(uri: string | null | undefined): void {
  if (uri === null || uri === undefined || !isInCache(uri)) {
    return;
  }

  try {
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  } catch {
    // Reclaimable by the OS in the end; nothing the caller can do about it now.
  }
}

/** Whether `uri` lies inside the app's cache directory. */
export function isInCache(uri: string): boolean {
  let root: string;
  try {
    root = Paths.cache.uri;
  } catch {
    return false;
  }
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return uri.startsWith(prefix) && !uri.slice(prefix.length).split('/').includes('..');
}
