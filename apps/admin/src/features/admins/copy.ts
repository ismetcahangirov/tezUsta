import type { AdminRole } from '@tezusta/types';

/** Admin management strings. English placeholder copy, like the rest of the panel. */
export const adminsCopy = {
  intro:
    'Everyone who can sign in to this panel. Nothing is ever deleted: an admin is disabled, and every change here is audited with its reason.',
  invite: 'Invite admin',
  loading: 'Loading admins…',
  loadFailed: 'The admin list could not be loaded.',
  retry: 'Try again',

  table: {
    caption: 'Admins',
    name: 'Admin',
    status: 'Status',
    roles: 'Roles',
    secondFactor: 'Setup',
    created: 'Added',
    actions: 'Actions',
    you: 'You',
    active: 'Active',
    disabled: 'Disabled',
    enrolled: 'Set up',
    notEnrolled: 'Not set up',
    invitationPending: 'Setup link pending',
    editRoles: 'Edit roles',
    disable: 'Disable',
    enable: 'Enable',
    resetSecondFactor: 'Reset second factor',
    actionFor: (action: string, name: string) => `${action}: ${name}`,
    ownRow:
      'You cannot change your own account — ask another super admin. This keeps the panel from ending up with nobody able to manage it.',
  },

  roleHints: {
    support: 'Live orders, disputes, phone reveal, calls; reads masters',
    moderator: 'Master verification and suspension, reviews',
    finance: 'Dispute outcomes; reads orders',
    super_admin: 'Everything, including the catalogue, the audit log and admins',
  } satisfies Record<AdminRole, string>,

  form: {
    email: 'Email',
    displayName: 'Display name',
    roles: 'Roles',
    rolesHint: 'At least one.',
    reason: 'Reason',
    reasonHint: 'Recorded in the audit log. Required, up to 600 characters.',
    cancel: 'Cancel',
    done: 'Done',
    emailInvalid: 'Enter an email address.',
    nameInvalid: 'Enter a name, up to 80 characters.',
    rolesEmpty: 'Choose at least one role.',
    reasonEmpty: 'Give a reason.',
    reasonTooLong: 'At most 600 characters.',
  },

  inviteDialog: {
    title: 'Invite an admin',
    explain:
      'The server makes a one-time setup link, valid for 24 hours. Nothing is emailed: you hand the link over yourself.',
    submit: 'Create invitation',
    submitting: 'Creating…',
  },

  rolesDialog: {
    title: (name: string) => `Roles of ${name}`,
    submit: 'Save roles',
    submitting: 'Saving…',
  },

  disableDialog: {
    title: (name: string) => `Disable ${name}`,
    explain: 'They are signed out everywhere at once and cannot sign in until re-enabled.',
    submit: 'Disable',
    submitting: 'Disabling…',
  },

  enableDialog: {
    title: (name: string) => `Enable ${name}`,
    explain: 'They can sign in again with their existing password and authenticator.',
    submit: 'Enable',
    submitting: 'Enabling…',
  },

  resetDialog: {
    title: (name: string) => `Reset second factor of ${name}`,
    explain:
      'Their password and authenticator stop working and every session ends. You get a new one-time setup link to hand over.',
    submit: 'Reset and issue link',
    submitting: 'Resetting…',
  },

  link: {
    title: 'Setup link',
    shownOnce:
      'Shown once. It is not stored anywhere you can see it again — copy it now and hand it over out of band (in person or over a call), never by email or chat.',
    expires: (when: string) => `Valid until ${when}, and for one use.`,
    for: (name: string, email: string) => `For ${name} (${email})`,
    copy: 'Copy link',
    copied: 'Copied.',
    copyFailed: 'Copying failed. Select the link and copy it by hand.',
  },

  errors: {
    ADMIN_SELF_ACTION_REFUSED: 'You cannot do this to your own account. Ask another super admin.',
    ADMIN_LAST_SUPER_ADMIN:
      'This would leave no active super admin. Make someone else a super admin first.',
    ADMIN_EMAIL_TAKEN: 'An admin with this email already exists.',
    validation: 'The server did not accept this. Check the fields and try again.',
    unexpected: 'Something went wrong. Try again.',
  },
} as const;
