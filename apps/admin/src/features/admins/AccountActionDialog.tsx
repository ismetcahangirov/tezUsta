import type { AdminAccount, AdminInvitationIssued, AdminRole } from '@tezusta/types';
import { type FormEvent, useState } from 'react';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import {
  useDisableAdminMutation,
  useEnableAdminMutation,
  useResetSecondFactorMutation,
  useSetAdminRolesMutation,
} from './api';
import { adminsCopy } from './copy';
import { accountErrorMessage, RoleCheckboxes } from './form-support';
import { SetupLinkPanel } from './SetupLinkPanel';

export type AccountAction = 'roles' | 'disable' | 'enable' | 'reset';

const DIALOG_TEXT = {
  disable: adminsCopy.disableDialog,
  enable: adminsCopy.enableDialog,
  reset: adminsCopy.resetDialog,
} as const;

/**
 * Every change to an existing admin needs a reason (ADR-0043 § 6): editing
 * roles, disabling, enabling, resetting the second factor. A reset answers
 * with a new setup link, shown once here exactly as an invitation's is.
 */
export function AccountActionDialog({
  account,
  action,
  onClose,
}: {
  account: AdminAccount;
  action: AccountAction;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [roles, setRoles] = useState<AdminRole[]>([...account.roles]);
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [rolesError, setRolesError] = useState<string | undefined>();
  const [issued, setIssued] = useState<AdminInvitationIssued | null>(null);

  const [setAdminRoles, rolesState] = useSetAdminRolesMutation();
  const [disable, disableState] = useDisableAdminMutation();
  const [enable, enableState] = useEnableAdminMutation();
  const [resetSecondFactor, resetState] = useResetSecondFactorMutation();
  const state = {
    roles: rolesState,
    disable: disableState,
    enable: enableState,
    reset: resetState,
  }[action];
  const failure = accountErrorMessage(state.error);
  const form = adminsCopy.form;

  const title =
    action === 'roles'
      ? adminsCopy.rolesDialog.title(account.displayName)
      : DIALOG_TEXT[action].title(account.displayName);
  const submitLabel = action === 'roles' ? adminsCopy.rolesDialog : DIALOG_TEXT[action];

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = reasonProblem(reason);
    setReasonError(
      problem === 'empty'
        ? form.reasonEmpty
        : problem === 'tooLong'
          ? form.reasonTooLong
          : undefined,
    );
    const noRoles = action === 'roles' && roles.length === 0;
    setRolesError(noRoles ? form.rolesEmpty : undefined);
    if (problem !== undefined || noRoles) return;

    const body = { id: account.id, reason: reason.trim() };
    switch (action) {
      case 'roles': {
        const result = await setAdminRoles({ ...body, roles });
        if (result.error === undefined) onClose();
        return;
      }
      case 'disable': {
        const result = await disable(body);
        if (result.error === undefined) onClose();
        return;
      }
      case 'enable': {
        const result = await enable(body);
        if (result.error === undefined) onClose();
        return;
      }
      case 'reset': {
        const result = await resetSecondFactor(body);
        if (result.data !== undefined) {
          setIssued(result.data);
          // The link lives in this dialog's state only, not in the store.
          resetState.reset();
        }
        return;
      }
    }
  }

  if (issued !== null) {
    return (
      <Dialog title={title} onClose={onClose}>
        <SetupLinkPanel issued={issued} />
        <div className="flex justify-end">
          <Button label={form.done} onClick={onClose} />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={title} onClose={onClose}>
      <form noValidate className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        {action !== 'roles' && (
          <p className="text-body text-text-muted">{DIALOG_TEXT[action].explain}</p>
        )}
        {failure !== undefined && <Banner tone="danger" message={failure} />}
        {action === 'roles' && (
          <RoleCheckboxes value={roles} onChange={setRoles} error={rolesError} />
        )}
        <ReasonField
          label={form.reason}
          hint={form.reasonHint}
          value={reason}
          error={reasonError}
          disabled={state.isLoading}
          onChange={setReason}
        />
        <div className="flex justify-end gap-2">
          <Button label={form.cancel} variant="secondary" onClick={onClose} />
          <Button
            type="submit"
            label={submitLabel.submit}
            loadingLabel={submitLabel.submitting}
            loading={state.isLoading}
          />
        </div>
      </form>
    </Dialog>
  );
}
