/**
 * The words around the support address. **Placeholders**: the copy is the
 * owner's (CLAUDE.md § 17), and these are the plainest factual Azerbaijani
 * that makes the line usable until it is written.
 */
export const SUPPORT_COPY = {
  /** Under the sign-in form, for someone who no longer reads their address. */
  lostAccess: 'E-poçtunuza girişiniz yoxdur?',
  /** The link that opens the mail app. */
  writeTo: (email: string): string => `${email} ünvanına yazın`,
  writeToLabel: (email: string): string => `Dəstəyə yazın: ${email}`,
  /** Appended to an existing "contact support" sentence once the address is set. */
  contactAt: (email: string): string => `Dəstək: ${email}`,
} as const;
