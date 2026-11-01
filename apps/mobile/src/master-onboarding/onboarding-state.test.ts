import type { MasterDocument, MasterDocumentType } from '@tezusta/types';

import { canSubmit, documentSlots, onboardingStep } from './onboarding-state';

function doc(
  documentType: MasterDocumentType,
  status: MasterDocument['status'],
  createdAt = '2026-11-01T10:00:00.000Z',
): MasterDocument {
  return {
    id: `${documentType}-${createdAt}`,
    documentType,
    status,
    sizeBytes: status === 'awaiting_upload' ? null : 1000,
    submittedAt: status === 'awaiting_upload' ? null : createdAt,
    createdAt,
    updatedAt: createdAt,
  };
}

const ALL_SENT = [
  doc('id_card_front', 'pending_review'),
  doc('id_card_back', 'pending_review'),
  doc('selfie_with_id', 'pending_review'),
];

describe('document slots', () => {
  it('reads a type with no document as missing', () => {
    expect(documentSlots([])).toEqual({
      id_card_front: 'missing',
      id_card_back: 'missing',
      selfie_with_id: 'missing',
    });
  });

  it('treats an upload that was never confirmed as missing, as the server does', () => {
    expect(documentSlots([doc('id_card_front', 'awaiting_upload')]).id_card_front).toBe('missing');
  });

  it('reads each review state', () => {
    const slots = documentSlots([
      doc('id_card_front', 'pending_review'),
      doc('id_card_back', 'accepted'),
      doc('selfie_with_id', 'rejected'),
    ]);
    expect(slots).toEqual({
      id_card_front: 'in_review',
      id_card_back: 'accepted',
      selfie_with_id: 'rejected',
    });
  });

  it('shows the newest document of a type when an older one is still listed', () => {
    const slots = documentSlots([
      doc('selfie_with_id', 'rejected', '2026-11-01T09:00:00.000Z'),
      doc('selfie_with_id', 'pending_review', '2026-11-01T11:00:00.000Z'),
    ]);
    expect(slots.selfie_with_id).toBe('in_review');
  });
});

describe('whether the documents can be submitted', () => {
  it('needs all three, sent or accepted', () => {
    expect(canSubmit(documentSlots(ALL_SENT))).toBe(true);
    expect(canSubmit(documentSlots(ALL_SENT.slice(0, 2)))).toBe(false);
  });

  it('refuses while a rejected document has not been replaced', () => {
    const slots = documentSlots([...ALL_SENT.slice(0, 2), doc('selfie_with_id', 'rejected')]);
    expect(canSubmit(slots)).toBe(false);
  });
});

describe('the onboarding step', () => {
  const none = documentSlots([]);
  const sent = documentSlots(ALL_SENT);

  it('asks for a profile when there is none', () => {
    expect(onboardingStep(null, none)).toBe('profile');
  });

  it('asks for documents until all three are sent', () => {
    expect(onboardingStep('pending_verification', none)).toBe('documents');
  });

  it('is waiting for review once a new profile has all three', () => {
    expect(onboardingStep('pending_verification', sent)).toBe('in_review');
  });

  it('stays on documents for changes requested, until the person submits', () => {
    expect(onboardingStep('changes_requested', sent)).toBe('documents');
  });

  it('has nothing left to do for a verified master', () => {
    expect(onboardingStep('active', sent)).toBe('active');
  });

  it('offers no path from rejected or suspended', () => {
    expect(onboardingStep('rejected', sent)).toBe('closed');
    expect(onboardingStep('suspended', sent)).toBe('closed');
  });
});
