/**
 * The strings this feature shows, in one place.
 *
 * Only one of them is user-visible today, and it is not visible inside the
 * app: Android renders a notification channel's name in the system settings
 * screen where a user turns categories off. It is written here rather than
 * inline so that the day the app is translated, the channel name is not the
 * one string nobody finds.
 */
export const notificationsCopy = {
  /**
   * The channel every notification currently lands in.
   *
   * Named for what it carries rather than for the product, because it sits in
   * a list of the phone's own making: "TezUsta → Sifariş bildirişləri" reads
   * as a category, "TezUsta → Default" reads as an oversight.
   */
  defaultChannelName: 'Sifariş bildirişləri',
} as const;
