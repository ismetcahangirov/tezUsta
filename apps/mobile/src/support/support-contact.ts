import { isPlausibleEmail, normaliseEmail } from '../auth/email-address';
import { SUPPORT_COPY } from './support-copy';

/**
 * The support address, from `EXPO_PUBLIC_SUPPORT_EMAIL` (ADR-0074 § 6, #516).
 *
 * **One config value, never a copy string.** The address is
 * `support@<domain>` and the domain is not chosen yet (#498, #505), so every
 * place that names it reads it from here, and every place hides its support
 * line while it is unset rather than showing a placeholder address somebody
 * might write to.
 *
 * Not a secret: it is printed on screen. Read once at module scope, because
 * Metro inlines `process.env.EXPO_PUBLIC_*` at bundle time.
 */
export function readSupportEmail(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  const normalised = normaliseEmail(raw);
  return isPlausibleEmail(normalised) ? normalised : null;
}

export const SUPPORT_EMAIL: string | null = readSupportEmail(process.env.EXPO_PUBLIC_SUPPORT_EMAIL);

/** What opens the phone's mail app addressed to support. */
export function supportMailUrl(email: string): string {
  return `mailto:${email}`;
}

/**
 * A "contact support" sentence, followed by the support address once one is
 * configured, so every such sentence in the app names the same channel (#516).
 * Unchanged while the address is unset.
 */
export function withSupportAddress(sentence: string, email: string | null = SUPPORT_EMAIL): string {
  return email === null ? sentence : `${sentence} ${SUPPORT_COPY.contactAt(email)}`;
}
