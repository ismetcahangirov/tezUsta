import type { MasterDocument, MasterDocumentType, MasterVerificationStatus } from '@tezusta/types';

/** The three ADR-0023 documents, in the order the screen asks for them. */
export const REQUIRED_DOCUMENTS: readonly MasterDocumentType[] = [
  'id_card_front',
  'id_card_back',
  'selfie_with_id',
];

/** What one document row shows. */
export type DocumentSlot = 'missing' | 'in_review' | 'accepted' | 'rejected';

/** Which part of becoming a master is on screen. */
export type OnboardingStep =
  /** No master profile yet: ask for the name. */
  | 'profile'
  /** A profile that may still change its documents and submit them. */
  | 'documents'
  /** Submitted and waiting for an admin. Documents can still be replaced. */
  | 'in_review'
  /** Verified: nothing left to do here. */
  | 'active'
  /** Rejected or suspended: no path forward from the app (ADR-0023). */
  | 'closed';

/**
 * The newest live document of each type, read as a slot.
 *
 * `awaiting_upload` is a presign whose bytes never got confirmed: to the
 * person it is the same as not having sent the photo, and the server agrees
 * (`submitForReview` does not count it). Newest wins, so a replacement shows
 * even if an older row of the same type is still in the list.
 */
export function documentSlots(
  documents: readonly MasterDocument[],
): Record<MasterDocumentType, DocumentSlot> {
  const newest = new Map<MasterDocumentType, MasterDocument>();
  for (const document of documents) {
    if (document.status === 'awaiting_upload') continue;
    const seen = newest.get(document.documentType);
    if (seen === undefined || document.createdAt > seen.createdAt) {
      newest.set(document.documentType, document);
    }
  }

  const slotOf = (type: MasterDocumentType): DocumentSlot => {
    const document = newest.get(type);
    if (document === undefined) return 'missing';
    if (document.status === 'accepted') return 'accepted';
    if (document.status === 'rejected') return 'rejected';
    return 'in_review';
  };

  return {
    id_card_front: slotOf('id_card_front'),
    id_card_back: slotOf('id_card_back'),
    selfie_with_id: slotOf('selfie_with_id'),
  };
}

/**
 * Whether every required document has bytes the server will count — the same
 * rule `submitForReview` applies, so the button is never enabled for a submit
 * the server would refuse as incomplete. A rejected document has to be
 * replaced first.
 */
export function canSubmit(slots: Record<MasterDocumentType, DocumentSlot>): boolean {
  return REQUIRED_DOCUMENTS.every(
    (type) => slots[type] === 'in_review' || slots[type] === 'accepted',
  );
}

/**
 * The step for a master profile, or for none.
 *
 * **A new profile is already `pending_verification`**, and the admin queue
 * lists masters by that status, so once its three documents are confirmed it
 * is waiting for review whether or not anyone taps submit — `submitForReview`
 * answers a `pending_verification` master without moving them. Hence: all
 * three present means `in_review`. `changes_requested` is different: only a
 * submit moves it back to `pending_verification`, so it stays on `documents`
 * until the person sends the replacements.
 */
export function onboardingStep(
  status: MasterVerificationStatus | null,
  slots: Record<MasterDocumentType, DocumentSlot>,
): OnboardingStep {
  if (status === null) return 'profile';
  if (status === 'active') return 'active';
  if (status === 'rejected' || status === 'suspended') return 'closed';
  if (status === 'changes_requested') return 'documents';
  return canSubmit(slots) ? 'in_review' : 'documents';
}
