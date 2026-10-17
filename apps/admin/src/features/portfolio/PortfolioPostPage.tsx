import type { AdminPortfolioPostDetail } from '@tezusta/types';
import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';

import { describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { formatDateTime } from '../../format';
import { useAppDispatch } from '../../hooks';
import { openInNewTab } from '../../open-in-new-tab';
import { PageFrame } from '../../shell/PageFrame';
import { portfolioApi, usePortfolioPostQuery } from './api';
import { portfolioCopy } from './copy';
import { postStatusLabel } from './PortfolioPage';
import { RemovePostDialog } from './RemovePostDialog';

function BackLink() {
  return (
    <Link
      to="/portfolio"
      className="self-start text-caption text-text-muted underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
    >
      ← {portfolioCopy.detail.back}
    </Link>
  );
}

/** One post (#312): who posted it, its photos, its removal, and the action to remove it. */
export function PortfolioPostPage() {
  const { id = '' } = useParams();
  const { data: post, error, isLoading, refetch } = usePortfolioPostQuery(id);
  const failure = describeFailure(error);
  const text = portfolioCopy.detail;

  if (post === undefined) {
    return (
      <PageFrame title={text.title}>
        <BackLink />
        {isLoading ? (
          <p role="status" className="text-body text-text-muted">
            {portfolioCopy.loading}
          </p>
        ) : failure?.status === 404 || failure?.code === 'VALIDATION_FAILED' ? (
          <Banner tone="danger" message={text.notFound} />
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Banner tone="danger" message={text.loadFailed} />
            <Button
              label={portfolioCopy.retry}
              variant="secondary"
              onClick={() => void refetch()}
            />
          </div>
        )}
      </PageFrame>
    );
  }

  return <Post post={post} />;
}

function Post({ post }: { post: AdminPortfolioPostDetail }) {
  const dispatch = useAppDispatch();
  const [removing, setRemoving] = useState(false);
  const [done, setDone] = useState<'removed' | 'alreadyRemoved' | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const text = portfolioCopy.detail;
  const removable = post.status === 'published' && post.removedAt === null;

  /**
   * Kept evidence is read through presigned URLs that expire within minutes
   * (ADR-0045 § 6), so the one a click opens is minted then, by re-reading
   * the post, not taken from the page as it was first loaded. That holds for
   * every removed post: one whose move has not finished may already be read
   * from the private bucket (#369), and re-reading a public URL costs nothing.
   */
  async function openEvidence(mediaId: string) {
    setOpenFailed(false);
    const opened = await openInNewTab(async () => {
      const result = await dispatch(
        portfolioApi.endpoints.portfolioPost.initiate(post.id, {
          forceRefetch: true,
          subscribe: false,
        }),
      );
      return result.data?.media.find((item) => item.id === mediaId)?.displayUrl ?? undefined;
    });
    setOpenFailed(!opened);
  }

  return (
    <PageFrame title={text.title}>
      <BackLink />
      {done !== null && <Banner message={text[done]} />}
      {openFailed && <Banner tone="danger" message={text.openFailed} />}

      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-md border-hairline border-border bg-surface p-4 lg:grid-cols-4">
        <Fact label={text.master}>
          <Link
            to={`/masters/${post.masterId}`}
            className="text-accent underline-offset-2 hover:underline"
          >
            {post.masterName}
          </Link>
        </Fact>
        <Fact label={portfolioCopy.table.status}>{postStatusLabel(post)}</Fact>
        <Fact label={text.created}>{formatDateTime(post.createdAt)}</Fact>
        <Fact label={text.published}>
          {post.publishedAt === null ? '—' : formatDateTime(post.publishedAt)}
        </Fact>
        <div className="col-span-full flex flex-col gap-1">
          <dt className="text-caption text-text-muted">{text.caption}</dt>
          <dd className="whitespace-pre-wrap break-words text-body text-text">
            {post.caption ?? portfolioCopy.table.noCaption}
          </dd>
        </div>
        {post.removedAt !== null && (
          <>
            <Fact label={text.removedAt}>{formatDateTime(post.removedAt)}</Fact>
            <div className="col-span-3 flex flex-col gap-1">
              <dt className="text-caption text-text-muted">{text.removalReason}</dt>
              <dd className="whitespace-pre-wrap break-words text-body text-text">
                {post.removalReason}
              </dd>
            </div>
            <p className="col-span-full text-caption text-text-muted">
              {portfolioCopy.evidence[post.evidence]}
            </p>
          </>
        )}
      </dl>

      {removable && (
        <div>
          <Button
            label={text.remove}
            variant="secondary"
            onClick={() => {
              setDone(null);
              setRemoving(true);
            }}
          />
        </div>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-h2 font-bold text-text">{text.photos}</h2>
        {post.media.every((item) => item.displayUrl === null) ? (
          <p className="text-body text-text-muted">{text.noPhotos}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {post.media.map((item) =>
              item.displayUrl === null ? null : (
                <li key={item.id}>
                  <a
                    href={item.displayUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={
                      post.removedAt !== null
                        ? (event) => {
                            event.preventDefault();
                            void openEvidence(item.id);
                          }
                        : undefined
                    }
                  >
                    <img
                      src={item.thumbUrl ?? item.displayUrl}
                      alt={text.photoAlt(item.position)}
                      className="aspect-square w-full rounded-md object-cover"
                    />
                  </a>
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      {removing && (
        <RemovePostDialog
          post={post}
          onClose={() => {
            setRemoving(false);
          }}
          onRemoved={(outcome) => {
            setDone(outcome);
          }}
        />
      )}
    </PageFrame>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="text-body text-text">{children}</dd>
    </div>
  );
}
