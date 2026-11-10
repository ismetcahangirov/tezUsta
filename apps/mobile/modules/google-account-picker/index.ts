import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

interface GoogleAccountPickerNative {
  pick(): Promise<string | null>;
}

// Android only. Optional, so Expo Go, iOS and web, which do not have the
// module, fall back to the plain keyboard instead of crashing (#510).
const native =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<GoogleAccountPickerNative>('GoogleAccountPicker')
    : null;

/** Whether this build can show the phone's Google accounts. */
export function canPickGoogleAccount(): boolean {
  return native !== null;
}

/**
 * Shows the phone's Google accounts and resolves to the address picked, or
 * `null` when the user backs out or the picker is not available.
 */
export async function pickGoogleAccount(): Promise<string | null> {
  if (native === null) {
    return null;
  }
  try {
    return await native.pick();
  } catch {
    return null;
  }
}
