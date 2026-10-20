import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether the system asks for reduced motion, kept current as the setting
 * changes (issue #398, the app's first animation).
 *
 * **Unknown counts as reduced.** The first answer is asynchronous, and a pulse
 * that starts and then stops a frame later is the one motion a person who
 * turned animation off must not see. So this is `true` until the platform has
 * answered, and the animation starts only when it says it may.
 */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) {
        setReduce(enabled);
      }
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      setReduce(enabled);
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduce !== false;
}
