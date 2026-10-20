import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

/**
 * Interim motion, owner-owned (ADR-0055 _Interim_): one ring growing out of
 * the address and fading, every two seconds. Functional, not the owner's
 * motion language, which is still unspecified.
 */
export const PULSE_MS = 2_000;
const SCALE_FROM = 0.15;
const SCALE_TO = 0.9;
const OPACITY_FROM = 0.6;
/** The ring that stands in when nothing may move: mid-size, faint, still. */
const STILL_SCALE = 0.5;
const STILL_OPACITY = 0.35;

export interface RadarPulseProps {
  /** False under reduce motion, while reconnecting, or in any state that is not searching. */
  readonly running: boolean;
}

/**
 * The radar's "looking" pulse (issue #398, ADR-0055 § 2).
 *
 * **A screen-space overlay above the map, not a map shape.** The address is
 * the camera's centre, so a ring centred on the card is centred on the
 * address. Animating a native `Circle`'s radius would re-render a map shape
 * every frame on the device with least to spare.
 *
 * **Native driver, `transform` and `opacity` only**, so the loop runs on the
 * UI thread and never re-renders React: the map's render count does not move
 * while it pulses. Stopped on unmount and whenever `running` turns false, when
 * a still ring stands in.
 *
 * Decoration: hidden from screen readers, and it never takes a touch.
 */
export function RadarPulse({ running }: RadarPulseProps): React.JSX.Element {
  const progress = useRef(new Animated.Value(running ? 0 : 1)).current;

  useEffect(() => {
    if (!running) {
      progress.stopAnimation();
      return undefined;
    }

    progress.setValue(0);
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: PULSE_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [running, progress]);

  const scale = running
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [SCALE_FROM, SCALE_TO] })
    : STILL_SCALE;
  const opacity = running
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [OPACITY_FROM, 0] })
    : STILL_OPACITY;

  return (
    <View
      testID={running ? 'radar-pulse-running' : 'radar-pulse-still'}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { opacity, transform: [{ scale }] }]}>
        <View className="h-full w-full rounded-full border-2 border-accent" />
      </Animated.View>
    </View>
  );
}
