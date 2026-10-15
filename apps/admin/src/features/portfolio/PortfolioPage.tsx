import type { AdminPortfolioPost } from '@tezusta/types';
import { type FormEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { SelectField } from '../../components/SelectField';
import { Table, TD_CLASS, TH_CLASS } from '../../components/Table';
import { TextField } from '../../components/TextField';
import { copy } from '../../copy';
import { formatDateTime } from '../../format';
import { PageFrame } from '../../shell/PageFrame';
import { isUuid } from '../../uuid';
import {
  type PortfolioFilters,
  type PortfolioStatusFilter,
  usePortfolioPostsInfiniteQuery,
} from './api';
import { portfolioCopy } from './copy';

const STATUSES = Object.keys(portfolioCopy.status) as PortfolioStatusFilter[];

/** The label a post's status column shows: a removal outranks the status it was removed from. */
export function postStatusLabel(post: AdminPortfolioPost): string {
  return post.removedAt !== null ? portfolioCopy.status.removed : portfolioCopy.status[post.status];
}

/**
 * Portfolio moderation (#312): every post with the filters the API supports,
 * a page at a time. A master's file links here with `?masterId=`. A caption
 * is a master's untrusted text and is rendered as text.
 */
export function PortfolioPage() {
  const [params] = useSearchParams();
  const initialMaster = params.get('masterId') ?? '';
  const [masterDraft, setMasterDraft] = useState(initialMaster);
  const [statusDraft, setStatusDraft] = useState('');
  const [masterError, setMasterError] = useState<string | undefined>();
  const [filters, setFilters] = useState<PortfolioFilters>(
    isUuid(initialMaster) ? { masterId: initialMaster } : {},
  );
  const { data, error, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } =
    usePortfolioPostsInfiniteQuery(filters);

  function apply(masterId: string, status: string) {
    const trimmed = masterId.trim();
    if (trimmed !== '' && !isUuid(trimmed)) {
      setMasterError(portfolioCopy.filters.invalidId);
      return;
    }
    setMasterError(undefined);
    setFilters({
      ...(trimmed === '' ? {} : { masterId: trimmed }),
      ...(status === '' ? {} : { status: status as PortfolioStatusFilter }),
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    apply(masterDraft, statusDraft);
  }

  const posts = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <PageFrame title={copy.nav.portfolio}>
      <p className="max-w-3xl text-body text-text-muted">{portfolioCopy.intro}</p>

      <form
        noValidate
        aria-label={portfolioCopy.filters.title}
        className="flex items-start gap-3 rounded-md border-hairline border-border bg-surface p-4"
        onSubmit={submit}
      >
        <TextField
          label={portfolioCopy.filters.masterId}
          value={masterDraft}
          error={masterError}
          spellCheck={false}
          onChange={(event) => {
            setMasterDraft(event.target.value);
          }}
        />
        <SelectField
          label={portfolioCopy.filters.status}
          value={statusDraft}
          options={[
            { value: '', label: portfolioCopy.filters.anyStatus },
            ...STATUSES.map((status) => ({ value: status, label: portfolioCopy.status[status] })),
          ]}
          onChange={(event) => {
            setStatusDraft(event.target.value);
          }}
        />
        <div className="flex gap-2 pt-6">
          <Button type="submit" label={portfolioCopy.filters.apply} />
          <Button
            label={portfolioCopy.filters.clear}
            variant="ghost"
            onClick={() => {
              setMasterDraft('');
              setStatusDraft('');
              apply('', '');
            }}
          />
        </div>
      </form>

      {data === undefined ? (
        isLoading || error === undefined ? (
          <p role="status" className="text-body text-text-muted">
            {portfolioCopy.loading}
          </p>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Banner tone="danger" message={portfolioCopy.loadFailed} />
            <Button
              label={portfolioCopy.retry}
              variant="secondary"
              onClick={() => void refetch()}
            />
          </div>
        )
      ) : posts.length === 0 ? (
        <p className="text-body text-text-muted">{portfolioCopy.empty}</p>
      ) : (
        <>
          <Table caption={portfolioCopy.table.caption}>
            <thead>
              <tr>
                <th className={TH_CLASS}>{portfolioCopy.table.created}</th>
                <th className={TH_CLASS}>{portfolioCopy.table.master}</th>
                <th className={TH_CLASS}>{portfolioCopy.table.status}</th>
                <th className={TH_CLASS}>{portfolioCopy.table.photos}</th>
                <th className={TH_CLASS}>{portfolioCopy.table.caption_}</th>
                <th className={TH_CLASS}>
                  <span className="sr-only">{portfolioCopy.table.open}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.id}>
                  <td className={TD_CLASS}>{formatDateTime(post.createdAt)}</td>
                  <td className={TD_CLASS}>{post.masterName}</td>
                  <td className={TD_CLASS}>{postStatusLabel(post)}</td>
                  <td className={TD_CLASS}>{String(post.mediaCount)}</td>
                  <td className={`${TD_CLASS} max-w-md whitespace-pre-wrap break-words`}>
                    {post.caption ?? portfolioCopy.table.noCaption}
                  </td>
                  <td className={TD_CLASS}>
                    <Link
                      to={`/portfolio/${post.id}`}
                      className="text-accent underline-offset-2 hover:underline"
                    >
                      {portfolioCopy.table.open}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {hasNextPage && (
            <Button
              label={portfolioCopy.loadMore}
              loadingLabel={portfolioCopy.loadingMore}
              loading={isFetchingNextPage}
              variant="secondary"
              className="self-start"
              onClick={() => void fetchNextPage()}
            />
          )}
        </>
      )}
    </PageFrame>
  );
}
