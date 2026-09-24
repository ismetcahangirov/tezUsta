import type { AdminAccount } from '@tezusta/types';
import { useState } from 'react';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Table, TD_CLASS, TH_CLASS } from '../../components/Table';
import { copy } from '../../copy';
import { formatDateTime } from '../../format';
import { PageFrame } from '../../shell/PageFrame';
import { useSignedInAdmin } from '../../shell/Shell';
import { type AccountAction, AccountActionDialog } from './AccountActionDialog';
import { useAdminsQuery } from './api';
import { adminsCopy } from './copy';
import { InviteDialog } from './InviteDialog';

type Open =
  | { readonly kind: 'invite' }
  | { readonly kind: 'action'; readonly account: AdminAccount; readonly action: AccountAction };

/**
 * Admin management (ADR-0043 §§ 1, 3, #251). The signed-in admin's own row
 * has its actions switched off: the server refuses self-disable and
 * self-re-role anyway (`ADMIN_SELF_ACTION_REFUSED`), and saying so up front
 * is kinder than a refusal.
 */
export function AdminsPage() {
  const me = useSignedInAdmin();
  const { data, error, isLoading, refetch } = useAdminsQuery();
  const [open, setOpen] = useState<Open | null>(null);
  const close = () => {
    setOpen(null);
  };

  return (
    <PageFrame title={copy.nav.admins}>
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-3xl text-body text-text-muted">{adminsCopy.intro}</p>
        <Button
          label={adminsCopy.invite}
          variant="accent"
          onClick={() => {
            setOpen({ kind: 'invite' });
          }}
        />
      </div>

      {data === undefined ? (
        isLoading || error === undefined ? (
          <p role="status" className="text-body text-text-muted">
            {adminsCopy.loading}
          </p>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Banner tone="danger" message={adminsCopy.loadFailed} />
            <Button label={adminsCopy.retry} variant="secondary" onClick={() => void refetch()} />
          </div>
        )
      ) : (
        <AdminTable
          accounts={data}
          myId={me.id}
          onAction={(account, action) => {
            setOpen({ kind: 'action', account, action });
          }}
        />
      )}

      {open?.kind === 'invite' && <InviteDialog onClose={close} />}
      {open?.kind === 'action' && (
        <AccountActionDialog account={open.account} action={open.action} onClose={close} />
      )}
    </PageFrame>
  );
}

function AdminTable({
  accounts,
  myId,
  onAction,
}: {
  accounts: readonly AdminAccount[];
  myId: string;
  onAction: (account: AdminAccount, action: AccountAction) => void;
}) {
  const text = adminsCopy.table;
  return (
    <Table caption={text.caption}>
      <thead>
        <tr>
          <th scope="col" className={TH_CLASS}>
            {text.name}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.status}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.roles}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.secondFactor}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.created}
          </th>
          <th scope="col" className={TH_CLASS}>
            {text.actions}
          </th>
        </tr>
      </thead>
      <tbody>
        {accounts.map((account) => {
          const mine = account.id === myId;
          const noteId = `own-row-${account.id}`;
          const action = (label: string, kind: AccountAction) => (
            <Button
              label={label}
              aria-label={text.actionFor(label, account.displayName)}
              aria-describedby={mine ? noteId : undefined}
              variant="secondary"
              disabled={mine}
              onClick={() => {
                onAction(account, kind);
              }}
            />
          );
          return (
            <tr
              key={account.id}
              className={account.status === 'disabled' ? 'text-text-muted' : undefined}
            >
              <td className={TD_CLASS}>
                <span className="flex items-center gap-2 font-bold">
                  {account.displayName}
                  {mine && (
                    <span className="rounded-full bg-accent px-2 text-footnote text-on-accent">
                      {text.you}
                    </span>
                  )}
                </span>
                <span className="block text-caption text-text-muted">{account.email}</span>
              </td>
              <td className={TD_CLASS}>
                {account.status === 'active' ? text.active : text.disabled}
              </td>
              <td className={TD_CLASS}>{account.roles.map((r) => copy.roles[r]).join(', ')}</td>
              <td className={TD_CLASS}>
                <span className="block">{account.enrolled ? text.enrolled : text.notEnrolled}</span>
                {account.invitationPending && (
                  <span className="block text-caption text-text-muted">
                    {text.invitationPending}
                  </span>
                )}
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap`}>
                {formatDateTime(account.createdAt)}
              </td>
              <td className={TD_CLASS}>
                <div className="flex flex-wrap gap-2">
                  {action(text.editRoles, 'roles')}
                  {account.status === 'active'
                    ? action(text.disable, 'disable')
                    : action(text.enable, 'enable')}
                  {action(text.resetSecondFactor, 'reset')}
                </div>
                {mine && (
                  <p id={noteId} className="pt-2 text-footnote text-text-muted">
                    {text.ownRow}
                  </p>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
