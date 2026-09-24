import type { AdminAuditEntry } from '@tezusta/types';
import { type FormEvent, Fragment, useState } from 'react';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Table, TD_CLASS, TH_CLASS } from '../../components/Table';
import { TextField } from '../../components/TextField';
import { copy } from '../../copy';
import { formatDateTime } from '../../format';
import { PageFrame } from '../../shell/PageFrame';
import { isUuid, shortId } from '../../uuid';
import { type AuditFilters, useAuditLogInfiniteQuery } from './api';
import { auditCopy } from './copy';
import { auditDiff } from './diff';

interface Draft {
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  /** `datetime-local` values, in the admin's own time zone. */
  from: string;
  to: string;
}

type DraftErrors = Partial<Record<keyof Draft, string>>;

const EMPTY_DRAFT: Draft = {
  actorId: '',
  action: '',
  targetType: '',
  targetId: '',
  from: '',
  to: '',
};

/** The API's own patterns (`admin-audit.schema.ts`), so a typo is caught before a 422. */
const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const TARGET_TYPE = /^[a-z][a-z0-9_]*$/;

/** A `datetime-local` value (local time, no zone) as the instant the API wants. */
function localToIso(value: string): string | undefined {
  if (value === '') return undefined;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** Checks the draft and, if it holds, turns it into the query the API takes. */
export function checkDraft(draft: Draft): { errors: DraftErrors; filters: AuditFilters } {
  const text = auditCopy.filters;
  const errors: DraftErrors = {};
  const actorId = draft.actorId.trim();
  const action = draft.action.trim();
  const targetType = draft.targetType.trim();
  const targetId = draft.targetId.trim();
  if (actorId !== '' && !isUuid(actorId)) errors.actorId = text.invalidId;
  if (action !== '' && (action.length > 64 || !ACTION.test(action))) {
    errors.action = text.invalidAction;
  }
  if (targetType !== '' && (targetType.length > 32 || !TARGET_TYPE.test(targetType))) {
    errors.targetType = text.invalidTargetType;
  }
  if (targetId !== '' && !isUuid(targetId)) errors.targetId = text.invalidId;
  else if (targetId !== '' && targetType === '') errors.targetType = text.targetIdNeedsType;
  const from = localToIso(draft.from);
  const to = localToIso(draft.to);
  if (from !== undefined && to !== undefined && Date.parse(from) >= Date.parse(to)) {
    errors.to = text.invalidRange;
  }

  const entries: [keyof AuditFilters, string | undefined][] = [
    ['actorId', actorId],
    ['action', action],
    ['targetType', targetType],
    ['targetId', targetId],
    ['from', from],
    ['to', to],
  ];
  const filters: AuditFilters = Object.fromEntries(
    entries.filter((entry): entry is [keyof AuditFilters, string] => (entry[1] ?? '') !== ''),
  );
  return { errors, filters };
}

/**
 * The audit log (ADR-0043 § 6, #251): filters, newest first, a cursor page at
 * a time, and each entry expandable to the before/after of what it changed.
 */
export function AuditPage() {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [filters, setFilters] = useState<AuditFilters>({});
  const { data, error, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } =
    useAuditLogInfiniteQuery(filters);
  const text = auditCopy.filters;

  function apply(next: Draft) {
    const checked = checkDraft(next);
    setDraft(next);
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length === 0) setFilters(checked.filters);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    apply(draft);
  }

  const field = (key: keyof Draft, label: string, extra: { hint?: string; type?: string } = {}) => (
    <TextField
      label={label}
      value={draft[key]}
      error={errors[key]}
      spellCheck={false}
      {...extra}
      onChange={(event) => {
        setDraft({ ...draft, [key]: event.target.value });
      }}
    />
  );

  const entries = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <PageFrame title={copy.nav.audit}>
      <p className="max-w-3xl text-body text-text-muted">{auditCopy.intro}</p>

      <form
        noValidate
        aria-label={text.title}
        className="grid grid-cols-3 items-start gap-3 rounded-md border-hairline border-border bg-surface p-4"
        onSubmit={submit}
      >
        {field('actorId', text.actorId)}
        {field('action', text.action, { hint: text.actionHint })}
        {field('targetType', text.targetType, { hint: text.targetTypeHint })}
        {field('targetId', text.targetId)}
        {field('from', text.from, { type: 'datetime-local' })}
        {field('to', text.to, { type: 'datetime-local' })}
        <div className="col-span-3 flex gap-2">
          <Button type="submit" label={text.apply} />
          <Button
            label={text.clear}
            variant="ghost"
            onClick={() => {
              apply(EMPTY_DRAFT);
            }}
          />
        </div>
      </form>

      {data === undefined ? (
        isLoading || error === undefined ? (
          <p role="status" className="text-body text-text-muted">
            {auditCopy.loading}
          </p>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Banner tone="danger" message={auditCopy.loadFailed} />
            <Button label={auditCopy.retry} variant="secondary" onClick={() => void refetch()} />
          </div>
        )
      ) : entries.length === 0 ? (
        <p className="text-body text-text-muted">{auditCopy.empty}</p>
      ) : (
        <>
          <AuditTable entries={entries} />
          {hasNextPage && (
            <Button
              label={auditCopy.loadMore}
              loadingLabel={auditCopy.loadingMore}
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

function AuditTable({ entries }: { entries: readonly AdminAuditEntry[] }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const text = auditCopy.table;

  function toggle(id: string) {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    setExpanded(next);
  }

  return (
    <Table caption={text.caption}>
      <thead>
        <tr>
          <th scope="col" className={TH_CLASS}>
            {text.when}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.actor}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.action}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.target}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.reason}
          </th>
          <th scope="col" className={TH_CLASS}>
            <span className="sr-only">{text.changes}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const open = expanded.has(entry.id);
          const detailsId = `audit-${entry.id}`;
          return (
            <Fragment key={entry.id}>
              <tr>
                <td className={`${TD_CLASS} whitespace-nowrap`}>
                  {formatDateTime(entry.createdAt)}
                </td>
                <td className={TD_CLASS}>
                  <span className="block">{entry.actor.displayName}</span>
                  <span className="block text-caption text-text-muted">{entry.actor.email}</span>
                </td>
                <td className={`${TD_CLASS} font-mono text-caption`}>{entry.action}</td>
                <td className={TD_CLASS}>
                  <span className="block">{entry.targetType}</span>
                  <span
                    className="block font-mono text-caption text-text-muted"
                    title={entry.targetId}
                  >
                    {shortId(entry.targetId)}
                  </span>
                </td>
                <td className={`${TD_CLASS} max-w-sm whitespace-pre-wrap break-words`}>
                  {entry.reason ?? text.noReason}
                </td>
                <td className={TD_CLASS}>
                  <Button
                    label={open ? text.hide : text.show}
                    aria-label={open ? text.hideFor(entry.action) : text.showFor(entry.action)}
                    aria-expanded={open}
                    aria-controls={open ? detailsId : undefined}
                    variant="ghost"
                    onClick={() => {
                      toggle(entry.id);
                    }}
                  />
                </td>
              </tr>
              {open && (
                <tr id={detailsId}>
                  <td colSpan={6} className={`${TD_CLASS} bg-surface-alt`}>
                    <EntryDiff entry={entry} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </Table>
  );
}

function EntryDiff({ entry }: { entry: AdminAuditEntry }) {
  const rows = auditDiff(entry.before, entry.after);
  const text = auditCopy.table;
  if (rows.length === 0) return <p className="text-caption text-text-muted">{text.noChanges}</p>;

  return (
    <table className="w-full border-collapse">
      <caption className="sr-only">{text.diffCaption(entry.action)}</caption>
      <thead>
        <tr>
          <th scope="col" className={TH_CLASS}>
            {text.field}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.before}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.after}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.field}>
            <th scope="row" className={`${TD_CLASS} font-mono text-caption font-regular`}>
              {row.field}
            </th>
            <td className={`${TD_CLASS} break-all font-mono text-caption`}>
              {row.before ?? text.absent}
            </td>
            <td className={`${TD_CLASS} break-all font-mono text-caption font-bold`}>
              {row.after ?? text.absent}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
