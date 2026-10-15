import type { AdminPortfolioPost } from '@tezusta/types';

import { describeFailure } from '../../api/api-error';
import { useRemoveMasterAvatarMutation, useRemovePortfolioPostMutation } from './api';
import { portfolioCopy } from './copy';
import { RemovalDialog } from './RemovalDialog';

/**
 * A post's removal with a mandatory reason (ADR-0045 § 6). The post is hidden
 * at once. A post someone else removed first is not a failure: the dialog
 * closes and the page, re-read, shows that removal and its reason.
 */
export function RemovePostDialog({
  post,
  onClose,
  onRemoved,
}: {
  post: AdminPortfolioPost;
  onClose: () => void;
  onRemoved: (outcome: 'removed' | 'alreadyRemoved') => void;
}) {
  const [remove, { isLoading, error }] = useRemovePortfolioPostMutation();
  const failure = describeFailure(error);
  const isError = failure !== undefined && failure.code !== 'PORTFOLIO_POST_ALREADY_REMOVED';
  const text = portfolioCopy.removal;
  return (
    <RemovalDialog
      title={text.title}
      hint={text.hint}
      confirm={text.confirm}
      failed={text.failed}
      isLoading={isLoading}
      isError={isError}
      onClose={onClose}
      onSubmit={async (reason) => {
        const result = await remove({ id: post.id, reason });
        if (describeFailure(result.error)?.code === 'PORTFOLIO_POST_ALREADY_REMOVED') {
          onRemoved('alreadyRemoved');
          return true;
        }
        if (result.error !== undefined) return false;
        onRemoved('removed');
        return true;
      }}
    >
      <blockquote className="whitespace-pre-wrap break-words rounded-sm bg-surface-alt px-4 py-3 text-body text-text">
        {post.masterName} — {post.caption ?? portfolioCopy.table.noCaption}
      </blockquote>
    </RemovalDialog>
  );
}

/** An avatar's removal with a mandatory reason (ADR-0045 § 8). Deleted at once, not kept. */
export function RemoveAvatarDialog({
  masterId,
  onClose,
  onRemoved,
}: {
  masterId: string;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [remove, { isLoading, isError }] = useRemoveMasterAvatarMutation();
  const text = portfolioCopy.avatar;
  return (
    <RemovalDialog
      title={text.dialogTitle}
      hint={text.hint}
      confirm={text.confirm}
      failed={text.failed}
      isLoading={isLoading}
      isError={isError}
      onClose={onClose}
      onSubmit={async (reason) => {
        const result = await remove({ masterId, reason });
        if (result.error !== undefined) return false;
        onRemoved();
        return true;
      }}
    />
  );
}
