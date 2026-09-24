import type { AdminInvitationIssued } from '@tezusta/types';
import { useState } from 'react';

import { Button } from '../../components/Button';
import { formatDateTime } from '../../format';
import { adminsCopy } from './copy';

/**
 * The one showing of a setup link (ADR-0043 § 3). It lives in the props of
 * this panel and the state of the dialog that holds it — never in the Redux
 * store, `localStorage` or the URL — so closing the dialog is the end of it.
 */
export function SetupLinkPanel({ issued }: { issued: AdminInvitationIssued }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const text = adminsCopy.link;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(issued.setupLink);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <section aria-label={text.title} className="flex flex-col gap-3">
      <p className="text-body text-text">
        {text.for(issued.admin.displayName, issued.admin.email)}
      </p>
      <p className="rounded-sm bg-danger px-4 py-3 text-caption text-on-danger">{text.shownOnce}</p>
      <label className="flex flex-col gap-2">
        <span className="text-caption text-text-muted">{text.title}</span>
        <input
          readOnly
          value={issued.setupLink}
          className="h-control-md w-full rounded-full border-hairline border-border bg-surface-alt px-5 font-mono text-caption text-text outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onFocus={(event) => {
            event.target.select();
          }}
        />
      </label>
      <p className="text-footnote text-text-muted">
        {text.expires(formatDateTime(issued.setupLinkExpiresAt))}
      </p>
      <div className="flex items-center gap-3">
        <Button label={text.copy} variant="accent" onClick={() => void copyLink()} />
        {copyState !== 'idle' && (
          <p role="status" className="text-caption text-text-muted">
            {copyState === 'copied' ? text.copied : text.copyFailed}
          </p>
        )}
      </div>
    </section>
  );
}
