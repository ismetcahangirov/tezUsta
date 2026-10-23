/**
 * What the master's web subscription page's sign-in and refresh answer with
 * ([ADR-0061](docs/decisions/ADR-0061-master-web-subscription-page.md)).
 *
 * **No token is in it.** The tokens are httpOnly cookies the page's script can
 * never read; the body says only when the session ends, so the page can say
 * so before it happens.
 */
export interface WebSession {
  /** ISO 8601. The session's absolute end, never moved by a refresh. */
  readonly sessionExpiresAt: string;
}
