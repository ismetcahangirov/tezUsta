import { useCallback, useEffect, useRef } from 'react';
import { StatusBar, type StatusBarProps } from 'react-native';

export interface ViewerStatusBar {
  /** Call before the viewer's modal is shown. */
  readonly beforeOpen: () => void;
  /** Call when it closes. */
  readonly afterClose: () => void;
}

/**
 * Light status bar text over the photo viewer, which is dark in both themes
 * (ADR-0054 § 3).
 *
 * **Pushed before the modal exists.** A modal takes the window's status bar
 * appearance when it is shown, so a `StatusBar` mounted inside it afterwards
 * changes nothing on Android, and iOS captures the style at creation. Popped on
 * close, or on unmount, which restores whatever the app's own `StatusBar` set.
 */
export function useViewerStatusBar(): ViewerStatusBar {
  const entry = useRef<StatusBarProps | null>(null);

  const beforeOpen = useCallback((): void => {
    entry.current ??= StatusBar.pushStackEntry({ barStyle: 'light-content', animated: false });
  }, []);

  const afterClose = useCallback((): void => {
    if (entry.current !== null) {
      StatusBar.popStackEntry(entry.current);
      entry.current = null;
    }
  }, []);

  useEffect(() => afterClose, [afterClose]);

  return { beforeOpen, afterClose };
}
