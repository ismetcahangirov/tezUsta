import { PHOTO_JPEG_QUALITY, PHOTO_MAX_EDGE_PX, preparePhoto } from './prepare-photo';

interface MockImage {
  readonly width: number;
  readonly height: number;
  saveAsync(options: unknown): Promise<{ uri: string; width: number; height: number }>;
  release(): void;
}

/** The size the platform decodes the picked file at. */
let mockDecodedSize = { width: 4032, height: 3024 };
let mockDecodeFails = false;
const mockLog = {
  sources: [] as unknown[],
  resizes: [] as unknown[],
  saves: [] as unknown[],
  created: 0,
  released: 0,
};

jest.mock('expo-image-manipulator', () => {
  function image(size: { width: number; height: number }): MockImage {
    mockLog.created += 1;
    return {
      ...size,
      saveAsync: (options) => {
        mockLog.saves.push(options);
        return Promise.resolve({ uri: 'file:///cache/out.jpg', ...size });
      },
      release: () => {
        mockLog.released += 1;
      },
    };
  }

  return {
    SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
    ImageManipulator: {
      manipulate: (source: string | MockImage) => {
        mockLog.sources.push(typeof source === 'string' ? source : 'decoded image');
        mockLog.created += 1;
        let size = typeof source === 'string' ? mockDecodedSize : source;
        const context = {
          resize: (next: { width?: number; height?: number }) => {
            mockLog.resizes.push(next);
            size =
              next.width === undefined
                ? {
                    width: Math.round((size.width * (next.height ?? 0)) / size.height),
                    height: next.height ?? 0,
                  }
                : {
                    width: next.width,
                    height: Math.round((size.height * next.width) / size.width),
                  };
            return context;
          },
          renderAsync: () =>
            mockDecodeFails
              ? Promise.reject(new Error('cannot decode'))
              : Promise.resolve(image(size)),
          release: () => {
            mockLog.released += 1;
          },
        };
        return context;
      },
    },
  };
});

beforeEach(() => {
  mockDecodedSize = { width: 4032, height: 3024 };
  mockDecodeFails = false;
  mockLog.sources = [];
  mockLog.resizes = [];
  mockLog.saves = [];
  mockLog.created = 0;
  mockLog.released = 0;
});

/** #319: every photo leaves the phone as a JPEG, its long edge capped. */
describe('preparePhoto', () => {
  it('re-encodes an iPhone HEIC as a JPEG, its long edge brought down to the cap', async () => {
    const photo = await preparePhoto('file:///DCIM/IMG_0001.HEIC');

    expect(mockLog.sources).toEqual(['file:///DCIM/IMG_0001.HEIC', 'decoded image']);
    expect(mockLog.resizes).toEqual([{ width: PHOTO_MAX_EDGE_PX }]);
    expect(mockLog.saves).toEqual([{ format: 'jpeg', compress: PHOTO_JPEG_QUALITY }]);
    expect(photo).toEqual({
      uri: 'file:///cache/out.jpg',
      width: 2560,
      height: 1920,
      mimeType: 'image/jpeg',
    });
  });

  it('caps a portrait photo by its height', async () => {
    mockDecodedSize = { width: 3024, height: 4032 };
    const photo = await preparePhoto('file:///a.heic');
    expect(mockLog.resizes).toEqual([{ height: PHOTO_MAX_EDGE_PX }]);
    expect(photo).toMatchObject({ width: 1920, height: 2560 });
  });

  it('leaves a photo already within the cap at its size, but still re-encodes it', async () => {
    mockDecodedSize = { width: 1200, height: 900 };
    const photo = await preparePhoto('file:///small.png');
    expect(mockLog.resizes).toEqual([]);
    expect(mockLog.saves).toEqual([{ format: 'jpeg', compress: PHOTO_JPEG_QUALITY }]);
    expect(photo).toMatchObject({ width: 1200, height: 900, mimeType: 'image/jpeg' });
  });

  it('frees every native image and context once the file is written', async () => {
    await preparePhoto('file:///DCIM/IMG_0001.HEIC');
    // Two contexts and two images: the decode, then the resize.
    expect(mockLog.created).toBe(4);
    expect(mockLog.released).toBe(4);
  });

  it('throws when the image cannot be decoded, and still frees what it held', async () => {
    mockDecodeFails = true;
    await expect(preparePhoto('file:///broken.heic')).rejects.toThrow('cannot decode');
    expect(mockLog.released).toBe(mockLog.created);
  });
});
