/** What this app installation last registered, as the server acknowledged it. */
export interface RegisteredDevice {
  /** The row's id, which is the only way to retire it — `DELETE /devices/:id`. */
  readonly id: string;
  /**
   * The token that id was registered with.
   *
   * Kept so a rotation can be recognised as one: re-posting an unchanged token
   * is a refresh of `lastSeenAt`, and posting a changed one is what makes a
   * rotated phone reachable again.
   */
  readonly expoPushToken: string;
}

/**
 * The device this installation is registered as.
 *
 * **Module memory, and deliberately not persisted.** The id is only ever
 * needed between a successful registration and the sign-out that follows it,
 * and the app re-registers on every launch — so a stored copy would be a
 * second source of truth whose only distinguishing feature is being able to
 * go stale. It is not a credential either: `expo-secure-store` holds tokens
 * that grant authority, and a device id grants none (CLAUDE.md §11).
 *
 * Not a Redux slice for the reason `tokenStore` is not one: it is read by
 * sign-out, which is transport-level work with no render cycle behind it.
 */
let current: RegisteredDevice | null = null;

export const registeredDevice = {
  current(): RegisteredDevice | null {
    return current;
  },

  remember(device: RegisteredDevice): void {
    current = device;
  },

  /**
   * Called at sign-out, after the row has been retired.
   *
   * Holding a previous user's device id would mean the next person to sign in
   * on this phone could retire a row that is no longer theirs to retire.
   */
  forget(): void {
    current = null;
  },
};
