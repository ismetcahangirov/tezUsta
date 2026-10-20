import { FAKE_CACHE_URI, fakeFiles } from '../../test/support/fake-file-system';
import { discardCachedFile, isInCache } from './cached-files';

/** Deleting the app's own cached copies of a photo, and nothing else (#408). */
describe('discardCachedFile', () => {
  beforeEach(() => {
    fakeFiles.reset();
  });

  it('deletes a file inside the app’s cache directory', () => {
    discardCachedFile(`${FAKE_CACHE_URI}ImageManipulator/converted.jpg`);

    expect(fakeFiles.deleted).toStrictEqual([`${FAKE_CACHE_URI}ImageManipulator/converted.jpg`]);
  });

  it.each([
    'file:///DCIM/IMG_0001.HEIC',
    'content://media/external/images/media/42',
    'file:///cache-lookalike/photo.jpg',
    `${FAKE_CACHE_URI}../Documents/photo.jpg`,
  ])('never touches %s, which is not the app’s own cache', (uri) => {
    discardCachedFile(uri);

    expect(fakeFiles.deleted).toStrictEqual([]);
  });

  it('does nothing for a file already gone, or for no file at all', () => {
    const uri = `${FAKE_CACHE_URI}ImagePicker/picked.jpeg`;
    discardCachedFile(uri);
    discardCachedFile(uri);
    discardCachedFile(null);
    discardCachedFile(undefined);

    expect(fakeFiles.deleted).toStrictEqual([uri]);
  });

  it('swallows a delete the platform refuses', () => {
    fakeFiles.deleteFails = true;

    expect(() => {
      discardCachedFile(`${FAKE_CACHE_URI}ImagePicker/picked.jpeg`);
    }).not.toThrow();
  });

  it('knows the cache directory with or without its trailing slash', () => {
    expect(isInCache(`${FAKE_CACHE_URI}a.jpg`)).toBe(true);
    expect(isInCache(FAKE_CACHE_URI.slice(0, -1))).toBe(false);
  });
});
