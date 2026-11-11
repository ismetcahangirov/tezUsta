import type {
  AccountRecoveryCancelSource,
  AccountRecoveryPhotoKind,
  AccountRecoveryStatus,
} from '@tezusta/types';

import type { ApiFailure } from '../../api/api-error';

/**
 * English placeholder copy for account recovery (#517, ADR-0074). The owner's
 * wording replaces it (CLAUDE.md § 17).
 */
export const recoveriesCopy = {
  title: 'Account recovery',
  intro:
    'Requests to move an account to a new sign-in address after the user lost the old one. A request waits 72 hours after the code is confirmed, and a second super admin approves the move.',
  tableCaption: 'Open recovery requests',
  columns: {
    account: 'Account',
    status: 'State',
    openedBy: 'Opened by',
    opened: 'Opened',
    holdLeft: 'Hold',
  },
  empty: 'No recovery is open.',
  loading: 'Loading…',
  loadFailed: 'The requests could not be loaded.',
  retry: 'Try again',
  none: '—',
  unknownAccount: 'Unnamed account',
  unknownAdmin: 'Unknown admin',
  you: 'you',

  status: {
    awaiting_code: 'Waiting for the code',
    on_hold: 'On hold',
    ready: 'Ready to approve',
    moved: 'Moved',
    cancelled: 'Cancelled',
  } satisfies Record<AccountRecoveryStatus, string>,
  cancelSource: {
    admin: 'by an admin',
    link: 'from the link sent to the old address',
    code_attempts: 'after too many wrong codes',
    stale: 'because the move could no longer happen',
  } satisfies Record<AccountRecoveryCancelSource, string>,

  holdLeft: (hours: number, minutes: number) =>
    hours > 0 ? `${String(hours)} h ${String(minutes)} min left` : `${String(minutes)} min left`,
  holdOver: 'Over',

  back: 'All recovery requests',
  detailLoadFailed: 'This request could not be loaded.',
  notFound: 'There is no recovery request with this id.',
  facts: 'Request',
  account: 'Account',
  openCustomer: 'Customer file',
  openMaster: 'Master file',
  oldEmail: 'Current address',
  newEmail: 'New address',
  openedBy: 'Opened by',
  openedAt: 'Opened',
  codeVerifiedAt: 'Code confirmed',
  holdUntil: 'Move allowed from',
  cancelled: 'Cancelled',
  cancelledBy: 'Cancelled by',
  cancelReason: 'Reason',
  approvedBy: 'Approved by',
  movedAt: 'Moved',
  evidence: 'Evidence notes',

  codeTitle: 'Code from the new address',
  codeBody:
    'A code was sent to the new address. Ask the user to read it back to you, and enter it here. The 72-hour hold starts when it is right, and the current address is told, with a link that cancels.',
  codeLabel: 'Code',
  codeInvalidShape: 'Enter the digits from the email.',
  confirmCode: 'Confirm code',
  confirmingCode: 'Confirming…',
  resend: 'Send a new code',
  resending: 'Sending…',
  resent: 'A new code was sent. The earlier one no longer works.',

  actions: 'Actions',
  cancel: 'Cancel request',
  approve: 'Approve move',
  revealEmails: 'Show addresses',
  approveOnlySuperAdmin: 'Only a super admin can approve the move.',
  approveNotOpener: 'You opened this request, so another super admin must approve it.',
  approveWaitHold: (until: string) => `The hold ends ${until}.`,
  approveWaitCode: 'The code from the new address has not been confirmed.',

  reasonLabel: 'Reason',
  reasonEmpty: 'Give a reason.',
  reasonTooLong: 'Keep the reason to 600 characters.',
  close: 'Close',
  keep: 'Keep request',
  cancelTitle: 'Cancel this recovery?',
  cancelBody:
    'The account keeps its current address. If the hold had started, the current address is told.',
  cancelHint: 'For example, the user called to say they did not ask for this.',
  cancelling: 'Cancelling…',
  approveTitle: 'Move this account?',
  approveBody:
    'The account will sign in with the new address. Every session ends, and both addresses are told. This cannot be undone from the panel.',
  approveHint: 'What you checked before approving.',
  approving: 'Approving…',
  revealTitle: 'Show both addresses',
  revealBody: 'Both addresses are personal data. Your reason is kept in the audit log.',
  revealHint: 'For example, matching the address the user wrote from.',
  reveal: 'Show',
  revealing: 'Showing…',
  moved: 'The account was moved to the new address.',
  cancelledNotice: 'The request was cancelled.',

  open: {
    button: 'Open account recovery',
    useMasterFile:
      'This account also has a master profile. Open its recovery from the master file, where the identity evidence applies.',
    title: 'Open an account recovery',
    newEmailLabel: 'New address',
    newEmailHint: 'The address the user wrote to support from.',
    newEmailInvalid: 'Enter a whole email address.',
    notesLabel: 'Evidence notes',
    notesHint: 'What you checked and how it matched. Do not copy ID numbers here.',
    notesEmpty: 'Describe the evidence.',
    notesTooLong: 'Keep the notes to 4000 characters.',
    submit: 'Open request',
    submitting: 'Opening…',
    cancel: 'Cancel',

    masterEvidence: 'Identity evidence',
    masterEvidenceBody:
      'Ask for a fresh selfie holding the same ID card, and a photo of the card’s front. Compare both with the documents on file in this master’s Documents section: the same card number and the same face.',
    masterPhotosNote:
      'Once the request is open, add both photos on its page, where they are shown beside the documents on file.',
    masterMatch: 'Same card, same face: the new photos match the documents on file.',
    masterMatchRequired: 'Confirm the match before opening the request.',

    customerEvidence: 'Account facts',
    customerEvidenceBody:
      'Ask the user, without prompting, for what they know about the account. Enter what they said first; the account’s own answers are shown after.',
    customerFacts: {
      name: 'The name on the account',
      address: 'The label of a saved address',
      order: 'The service and rough date of a recent order',
      master: 'The name of a master who worked on an order',
    },
    saidLabel: (fact: string) => `What the user said: ${fact}`,
    compare: 'Compare with the account',
    accountHas: 'The account has',
    accountHasNothing: 'Nothing on the account to compare.',
    matches: (fact: string) => `Matches: ${fact}`,
    factsRequired: (count: number) =>
      `Confirm at least three matching facts (${String(count)} so far).`,
    summary: (facts: readonly string[]) => `Matched facts: ${facts.join('; ')}.`,
  },

  photos: {
    title: 'Evidence photos',
    intro:
      'The new photos the user sent, beside the documents on file. Each photo opened is recorded in the audit log.',
    caption: 'Evidence photos and documents on file',
    columns: { kind: 'Photo', added: 'New photo', onFile: 'On file' },
    kind: {
      selfie_with_id: 'Selfie with the ID card',
      id_card_front: 'ID card, front',
    } satisfies Record<AccountRecoveryPhotoKind, string>,
    open: 'Open',
    opening: 'Opening…',
    openLabel: (what: string) => `Open ${what}`,
    openFileLabel: (what: string) => `Open ${what} on file`,
    openFailed: 'The photo could not be opened. Try again.',
    added: (name: string, at: string) => `Added by ${name}, ${at}`,
    uploadLabel: (what: string) => `Add: ${what}`,
    uploading: 'Uploading…',
    notAdded: 'Not added',
    noneOnFile: 'Nothing on file',
    loadFailed: 'The photos could not be loaded.',
    filesUnavailable: 'The documents on file could not be loaded.',
    notImage: 'Choose a JPEG, PNG or WebP photo.',
    tooLarge: (limit: string) => `The photo is larger than ${limit}. Send a smaller one.`,
    storageUnreachable:
      'The photo could not reach storage. Nothing was saved. If this keeps happening, the storage setup for the panel needs checking (ADR-0075).',
    refused: 'The file is not a JPEG, PNG or WebP photo, or is over the size limit. Nothing was saved.',
    notArrived: 'The upload did not finish. Try again.',
  },

  errors: {
    ACCOUNT_RECOVERY_PHOTOS_MASTER_ONLY: 'Photos are evidence for a master’s account only.',
    ACCOUNT_RECOVERY_PHOTO_EXISTS:
      'This photo is already on the request. To use a different one, cancel the request and open a new one.',
    ACCOUNT_RECOVERY_ALREADY_OPEN: 'This account already has an open recovery.',
    ACCOUNT_RECOVERY_CHANGE_PENDING:
      'The user has an address change of their own pending. It must finish or expire first.',
    ACCOUNT_RECOVERY_ACCOUNT_INACTIVE: 'The account is suspended or deleted.',
    ACCOUNT_RECOVERY_CODE_INVALID: 'The code is wrong or has expired.',
    ACCOUNT_RECOVERY_NOT_ALLOWED_NOW: 'The request has moved on. Reload to see where it stands.',
    ACCOUNT_RECOVERY_HOLD_RUNNING: 'The 72-hour hold has not ended.',
    ACCOUNT_RECOVERY_SAME_ADMIN: 'The admin who opened a request cannot approve it.',
    EMAIL_ADDRESS_TAKEN: 'Another account already signs in with this address.',
    EMAIL_CHANGE_SAME_ADDRESS: 'This is already the account’s address.',
    FORBIDDEN: 'You do not have permission to do this.',
    NOT_FOUND: 'The request or the account no longer exists.',
    VALIDATION_FAILED: 'The server did not accept these details.',
    RATE_LIMITED: 'Too many tries. Wait a little and try again.',
    sendRefused:
      'The code could not be sent right now. The request is listed under Account recovery; send a new code from there in a little while.',
    unexpected: 'Something went wrong. Try again.',
  },
} as const;

type KnownCode = Exclude<keyof typeof recoveriesCopy.errors, 'sendRefused' | 'unexpected'>;

function isKnownCode(code: string | undefined): code is KnownCode {
  return code !== undefined && code in recoveriesCopy.errors && code !== 'sendRefused';
}

/** One sentence per refusal #515 can give, so the admin knows which rule stopped them. */
export function recoveryErrorMessage(failure: ApiFailure | undefined): string {
  if (failure === undefined) return recoveriesCopy.errors.unexpected;
  if (isKnownCode(failure.code)) return recoveriesCopy.errors[failure.code];
  // The platform's code-sending budget answers 503 (ADR-0072).
  if (failure.status === 503) return recoveriesCopy.errors.sendRefused;
  return recoveriesCopy.errors.unexpected;
}
