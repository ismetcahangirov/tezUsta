/**
 * Opens a short-lived URL the server mints on demand — a presigned read of a
 * document or a photo — in a new tab.
 *
 * The tab is opened **synchronously, inside the click**, and pointed at the
 * URL once it arrives: a `window.open` after an `await` is no longer a user
 * gesture, and popup blockers refuse it. `opener` is cut before navigating so
 * the storage origin cannot reach back into the panel. If the request fails
 * the empty tab is closed and `false` is returned for the caller to explain.
 *
 * The URL is used once and never kept: it expires within minutes, and every
 * fetch of it is an audited read (ADR-0043 § 6).
 */
export async function openInNewTab(mint: () => Promise<string | undefined>): Promise<boolean> {
  const tab = window.open('', '_blank');
  const url = await mint();
  if (url === undefined) {
    tab?.close();
    return false;
  }
  if (tab === null) {
    // Blocked anyway; a plain navigation is still a new tab in most browsers.
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
  tab.opener = null;
  tab.location.href = url;
  return true;
}
