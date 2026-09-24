import { router, Stack } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { CallPhase } from './call-machine';
import { useHoldCallScreen } from './useHoldCallScreen';

/** A call screen reduced to what the hold reads: its phase, and a way to end it. */
function HeldScreen(): React.JSX.Element {
  const [phase, setPhase] = useState<CallPhase>('active');
  useHoldCallScreen(phase);
  return (
    <View>
      <Text>{`call ${phase}`}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setPhase('ended');
        }}
      >
        <Text>end</Text>
      </Pressable>
    </View>
  );
}

/**
 * `renderRouter` wraps React Native Testing Library's `render`, which is
 * asynchronous in the installed version, and decorates the value it returns —
 * so the pathname reader is taken off that value before it is awaited.
 */
async function mountAtCall(): Promise<{ readonly getPathname: () => string }> {
  const rendered = renderRouter(
    {
      _layout: () => <Stack screenOptions={{ headerShown: false }} />,
      index: () => <Text>home</Text>,
      call: HeldScreen,
    },
    { initialUrl: '/' },
  );
  const getPathname = (): string => rendered.getPathname();
  await (rendered as unknown as Promise<unknown>);
  await act(async () => {
    router.push('/call');
    await Promise.resolve();
  });
  return { getPathname };
}

/**
 * Hardware back on Android is a removal of the screen, which is what
 * `router.back()` dispatches here: the same `beforeRemove` path the
 * hold intercepts (#188 review, item 3).
 */
describe('useHoldCallScreen', () => {
  it('refuses to leave a live call', async () => {
    const rendered = await mountAtCall();
    expect(await screen.findByText('call active')).toBeOnTheScreen();

    await act(async () => {
      router.back();
      await Promise.resolve();
    });

    expect(rendered.getPathname()).toBe('/call');
    expect(screen.getByText('call active')).toBeOnTheScreen();
  });

  it('lets an ended call close', async () => {
    const rendered = await mountAtCall();
    await screen.findByText('call active');
    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: 'end' }));
    });
    expect(await screen.findByText('call ended')).toBeOnTheScreen();

    await act(async () => {
      router.back();
      await Promise.resolve();
    });

    expect(rendered.getPathname()).toBe('/');
  });
});
