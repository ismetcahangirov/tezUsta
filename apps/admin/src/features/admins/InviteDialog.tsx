import type { AdminInvitationIssued, AdminRole } from '@tezusta/types';
import { type FormEvent, useState } from 'react';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { TextField } from '../../components/TextField';
import { useInviteAdminMutation } from './api';
import { adminsCopy } from './copy';
import { accountErrorMessage, RoleCheckboxes } from './form-support';
import { SetupLinkPanel } from './SetupLinkPanel';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Errors {
  email?: string;
  displayName?: string;
  roles?: string;
}

/**
 * Invite an admin: email, display name, at least one role — then the setup
 * link, shown once, in this dialog only (ADR-0043 § 3).
 */
export function InviteDialog({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [issued, setIssued] = useState<AdminInvitationIssued | null>(null);
  const [invite, { isLoading, error, reset }] = useInviteAdminMutation();
  const text = adminsCopy.form;
  const failure = accountErrorMessage(error);
  const emailTaken = failure === adminsCopy.errors.ADMIN_EMAIL_TAKEN;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Errors = {};
    if (!EMAIL.test(email.trim()) || email.trim().length > 320) found.email = text.emailInvalid;
    if (displayName.trim() === '' || displayName.trim().length > 80) {
      found.displayName = text.nameInvalid;
    }
    if (roles.length === 0) found.roles = text.rolesEmpty;
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const result = await invite({ email: email.trim(), displayName: displayName.trim(), roles });
    if (result.data !== undefined) {
      setIssued(result.data);
      // Drop the answer from the store at once: the link lives in this dialog's state only.
      reset();
    }
  }

  return (
    <Dialog title={adminsCopy.inviteDialog.title} onClose={onClose}>
      {issued === null ? (
        <form noValidate className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <p className="text-body text-text-muted">{adminsCopy.inviteDialog.explain}</p>
          {failure !== undefined && !emailTaken && <Banner tone="danger" message={failure} />}
          <TextField
            label={text.email}
            type="email"
            autoComplete="off"
            value={email}
            error={errors.email ?? (emailTaken ? failure : undefined)}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <TextField
            label={text.displayName}
            autoComplete="off"
            value={displayName}
            error={errors.displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
            }}
          />
          <RoleCheckboxes value={roles} onChange={setRoles} error={errors.roles} />
          <div className="flex justify-end gap-2">
            <Button label={text.cancel} variant="secondary" onClick={onClose} />
            <Button
              type="submit"
              label={adminsCopy.inviteDialog.submit}
              loadingLabel={adminsCopy.inviteDialog.submitting}
              loading={isLoading}
            />
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <SetupLinkPanel issued={issued} />
          <div className="flex justify-end">
            <Button label={text.done} onClick={onClose} />
          </div>
        </div>
      )}
    </Dialog>
  );
}
