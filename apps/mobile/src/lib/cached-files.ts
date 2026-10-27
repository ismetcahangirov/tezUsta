import { Directory, File, Paths } from 'expo-file-system';

/**
 * The cache subdirectories the photo libraries write into: `preparePhoto`'s
 * JPEGs (`expo-image-manipulator`) and the picker's copies (`expo-image-picker`
 * on Android). Read from the installed packages' native code, not their docs.
 * On iOS the picker's path has an operator-precedence slip and its copy can
 * land in the cache root instead; that copy is deleted as soon as the photo
 * is prepared, so the sweep does not chase it there.
 */
const PHOTO_CACHE_DIRECTORIES = ['ImageManipulator', 'ImagePicker'] as const;

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

/**
 * Deletes every photo left in the libraries' cache directories by an earlier
 * run of the app (#458): a message that failed and was never resent, or an
 * upload the app was killed in the middle of. Nothing outlives the run that
 * made it — the outbox and every upload hook live in memory — so at cold
 * start no file there is still needed.
 *
 * **Call it once, at module scope, before anything mounts.** Called later, it
 * could delete a photo an upload in this run is still using.
 *
 * Never throws, like {@link discardCachedFile}, which deletes each file and
 * keeps its refusal to touch anything outside the cache.
 */
export function sweepCachedPhotos(): void {
  for (const name of PHOTO_CACHE_DIRECTORIES) {
    try {
      const directory = new Directory(Paths.cache, name);
      if (!directory.exists) {
        continue;
      }
      for (const entry of directory.list()) {
        if (entry instanceof File) {
          discardCachedFile(entry.uri);
        }
      }
    } catch {
      // A directory the platform will not list is left to the OS.
    }
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
