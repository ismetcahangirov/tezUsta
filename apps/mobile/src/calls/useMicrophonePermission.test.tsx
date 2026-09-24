import { act, renderHook } from '@testing-library/react-native';

import { useMicrophonePermission } from './useMicrophonePermission';

const mockRequest = jest.fn<Promise<{ granted: boolean }>, []>();

jest.mock('expo-audio', () => ({
  requestRecordingPermissionsAsync: () => mockRequest(),
}));

beforeEach(() => {
  mockRequest.mockReset();
});

describe('useMicrophonePermission', () => {
  it('asks nothing on mount', async () => {
    await renderHook(() => useMicrophonePermission());

    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('resolves true when the microphone is granted', async () => {
    mockRequest.mockResolvedValue({ granted: true });
    const hook = await renderHook(() => useMicrophonePermission());

    let granted: boolean | undefined;
    await act(async () => {
      granted = await hook.result.current.request();
    });

    expect(granted).toBe(true);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('resolves false when it is refused', async () => {
    mockRequest.mockResolvedValue({ granted: false });
    const hook = await renderHook(() => useMicrophonePermission());

    let granted: boolean | undefined;
    await act(async () => {
      granted = await hook.result.current.request();
    });

    expect(granted).toBe(false);
  });

  it('resolves false, not a thrown error, when the native call fails', async () => {
    mockRequest.mockRejectedValue(new Error('no module'));
    const hook = await renderHook(() => useMicrophonePermission());

    let granted: boolean | undefined;
    await act(async () => {
      granted = await hook.result.current.request();
    });

    expect(granted).toBe(false);
  });

  it('does not report a grant to a surface that has already closed', async () => {
    let answer: (value: { granted: boolean }) => void = () => undefined;
    mockRequest.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const hook = await renderHook(() => useMicrophonePermission());

    const pending = hook.result.current.request();
    await hook.unmount();
    answer({ granted: true });

    await expect(pending).resolves.toBe(false);
  });
});
