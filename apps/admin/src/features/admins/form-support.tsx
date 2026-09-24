import type { SerializedError } from '@reduxjs/toolkit';
import type { FetchBaseQueryError } from '@reduxjs/toolkit/query';
import type { AdminRole } from '@tezusta/types';

import { describeFailure } from '../../api/api-error';
import { Checkbox } from '../../components/Checkbox';
import { copy } from '../../copy';
import { adminsCopy } from './copy';

export const ALL_ROLES: readonly AdminRole[] = ['support', 'moderator', 'finance', 'super_admin'];

/** What an admin-management refusal means, in the panel's words — keyed by the stable code. */
export function accountErrorMessage(
  error: FetchBaseQueryError | SerializedError | undefined,
): string | undefined {
  const failure = describeFailure(error);
  if (failure === undefined) return undefined;
  switch (failure.code) {
    case 'ADMIN_SELF_ACTION_REFUSED':
    case 'ADMIN_LAST_SUPER_ADMIN':
    case 'ADMIN_EMAIL_TAKEN':
      return adminsCopy.errors[failure.code];
    default:
      return failure.status === 422 ? adminsCopy.errors.validation : adminsCopy.errors.unexpected;
  }
}

/** One checkbox per role, with what the role can do; at least one must stay chosen. */
export function RoleCheckboxes({
  value,
  onChange,
  error,
}: {
  value: readonly AdminRole[];
  onChange: (roles: AdminRole[]) => void;
  error?: string | undefined;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-2 text-caption text-text-muted">{adminsCopy.form.roles}</legend>
      {ALL_ROLES.map((role) => (
        <div key={role} className="flex flex-col">
          <Checkbox
            label={copy.roles[role]}
            checked={value.includes(role)}
            onChange={(event) => {
              // Keep the canonical order, whatever order they were ticked in.
              onChange(
                ALL_ROLES.filter((r) => (r === role ? event.target.checked : value.includes(r))),
              );
            }}
          />
          <span className="pl-6 text-footnote text-text-muted">{adminsCopy.roleHints[role]}</span>
        </div>
      ))}
      <p className={`text-footnote ${error === undefined ? 'text-text-muted' : 'text-danger'}`}>
        {error ?? adminsCopy.form.rolesHint}
      </p>
    </fieldset>
  );
}
