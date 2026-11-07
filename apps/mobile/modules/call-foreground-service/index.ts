import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

interface CallForegroundServiceNative {
  start(title: string, text: string): void;
  stop(): void;
}

// Android only; iOS keeps a call alive through the `audio` background mode.
const native =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<CallForegroundServiceNative>('CallForegroundService')
    : null;

/** Starts the call's foreground service. Call it while the app is on screen. */
export function startCallForegroundService(title: string, text: string): void {
  native?.start(title, text);
}

/** Stops it; safe to call when it is not running. */
export function stopCallForegroundService(): void {
  native?.stop();
}
