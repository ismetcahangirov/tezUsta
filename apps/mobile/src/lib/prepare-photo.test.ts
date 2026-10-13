import { PHOTO_JPEG_QUALITY, PHOTO_MAX_EDGE_PX, preparePhoto } from './prepare-photo';

const mockManipulated: { uri: string; resizes: unknown[]; saves: unknown[] }[] = [];
let mockDecodeFails = false;

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
  ImageManipulator: {
    manipulate: (uri: string) => {
      const record = { uri, resizes: [] as unknown[], saves: [] as unknown[] };
      mockManipulated.push(record);
      let size = { width: 4032, height: 3024 };
      const context = {
        resize: (next: { width?: number; height?: number }) => {
          record.resizes.push(next);
          size =
            next.width === undefined
              ? {
                  width: Math.round((size.width * (next.height ?? 0)) / size.height),
                  height: next.height ?? 0,
                }
              : { width: next.width, height: Math.round((size.height * next.width) / size.width) };
          return context;
        },
        renderAsync: () =>
          mockDecodeFails
            ? Promise.reject(new Error('cannot decode'))
            : Promise.resolve({
                saveAsync: (options: unknown) => {
                  record.saves.push(options);
                  return Promise.resolve({ uri: 'file:///cache/out.jpg', ...size });
                },
              }),
      };
      return context;
    },
  },
}));

beforeEach(() => {
  mockManipulated.length = 0;
  mockDecodeFails = false;
});

/** #319: every photo leaves the phone as a JPEG, its long edge capped. */
describe('preparePhoto', () => {
  it('re-encodes an iPhone HEIC as a JPEG, its long edge brought down to the cap', async () => {
    const photo = await preparePhoto({
      uri: 'file:///DCIM/IMG_0001.HEIC',
      width: 4032,
      height: 3024,
    });

    expect(mockManipulated).toEqual([
      {
        uri: 'file:///DCIM/IMG_0001.HEIC',
        resizes: [{ width: PHOTO_MAX_EDGE_PX }],
        saves: [{ format: 'jpeg', compress: PHOTO_JPEG_QUALITY }],
      },
    ]);
    expect(photo).toEqual({
      uri: 'file:///cache/out.jpg',
      width: 2560,
      height: 1920,
      mimeType: 'image/jpeg',
    });
  });

  it('caps a portrait photo by its height', async () => {
    await preparePhoto({ uri: 'file:///a.heic', width: 3024, height: 4032 });
    expect(mockManipulated[0]?.resizes).toEqual([{ height: PHOTO_MAX_EDGE_PX }]);
  });

  it('leaves a photo already within the cap at its size, but still re-encodes it', async () => {
    const photo = await preparePhoto({ uri: 'file:///small.png', width: 1200, height: 900 });
    expect(mockManipulated[0]?.resizes).toEqual([]);
    expect(mockManipulated[0]?.saves).toEqual([{ format: 'jpeg', compress: PHOTO_JPEG_QUALITY }]);
    expect(photo.mimeType).toBe('image/jpeg');
  });

  it('throws when the image cannot be decoded, for the caller to treat as a failed upload', async () => {
    mockDecodeFails = true;
    await expect(
      preparePhoto({ uri: 'file:///broken.heic', width: 10, height: 10 }),
    ).rejects.toThrow('cannot decode');
  });
});
