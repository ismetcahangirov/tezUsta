import type { Master, MasterDocument } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';

import { MASTER_ONBOARDING_COPY as copy } from './master-onboarding-copy';
import { MasterOnboarding } from './MasterOnboarding';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(() => Promise.resolve({ granted: false })),
  launchImageLibraryAsync: jest.fn(),
}));

function master(verificationStatus: Master['verificationStatus']): Master {
  return {
    id: 'master-1',
    displayName: 'Elvin',
    bio: null,
    verificationStatus,
    suspendedAt: null,
    isAvailable: false,
    ratingAverage: null,
    ratingCount: 0,
    avatarUrl: null,
    avatarLargeUrl: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  };
}

function doc(
  documentType: MasterDocument['documentType'],
  status: MasterDocument['status'],
): MasterDocument {
  return {
    id: `doc-${documentType}`,
    documentType,
    status,
    sizeBytes: 1000,
    submittedAt: '2026-11-01T10:00:00.000Z',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  };
}

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
}

let replies: Record<string, Reply> = {};
const requests: { method: string; pathname: string; body: string }[] = [];

function installTransport(): void {
  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      pathname: url.pathname,
      body: await request.clone().text(),
    });
    const reply = replies[`${request.method} ${url.pathname}`] ?? { status: 404, body: {} };
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

const onBack = jest.fn();
const onOpenMaster = jest.fn();

async function mount(): Promise<void> {
  installTransport();
  await render(
    <Provider store={createTestStore()}>
      <MasterOnboarding onBack={onBack} onOpenMaster={onOpenMaster} />
    </Provider>,
  );
}

beforeEach(() => {
  replies = {};
  requests.length = 0;
  onBack.mockClear();
  onOpenMaster.mockClear();
});

describe('becoming a master (#490)', () => {
  it('asks for a profile when the account is not a master yet', async () => {
    replies['GET /masters/me'] = { status: 403, body: {} };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.profileTitle)).toBeOnTheScreen();
    });
  });

  it('creates the profile with the trimmed name, then asks for the documents', async () => {
    replies['GET /masters/me'] = { status: 403, body: {} };
    replies['POST /masters'] = { status: 201, body: master('pending_verification') };
    await mount();

    await waitFor(() => {
      expect(screen.getByLabelText(copy.nameField)).toBeOnTheScreen();
    });
    await fireEvent.changeText(screen.getByLabelText(copy.nameField), '  Elvin  ');
    replies['GET /masters/me'] = { body: master('pending_verification') };
    replies['GET /masters/me/documents'] = { body: [] };
    await fireEvent.press(screen.getByRole('button', { name: copy.profileAction }));

    await waitFor(() => {
      expect(screen.getByText(copy.documentsTitle)).toBeOnTheScreen();
    });
    const create = requests.find((r) => r.method === 'POST' && r.pathname === '/masters');
    expect(JSON.parse(create?.body ?? '{}')).toEqual({ displayName: 'Elvin' });
    expect(screen.getByText(copy.documentLabels.id_card_front)).toBeOnTheScreen();
    expect(screen.getByText(copy.documentLabels.id_card_back)).toBeOnTheScreen();
    expect(screen.getByText(copy.documentLabels.selfie_with_id)).toBeOnTheScreen();
  }, 15_000);

  it('shows the wait for review once all three documents are sent', async () => {
    replies['GET /masters/me'] = { body: master('pending_verification') };
    replies['GET /masters/me/documents'] = {
      body: [
        doc('id_card_front', 'pending_review'),
        doc('id_card_back', 'pending_review'),
        doc('selfie_with_id', 'pending_review'),
      ],
    };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.inReviewTitle)).toBeOnTheScreen();
    });
    await fireEvent.press(screen.getByRole('button', { name: copy.goToMaster }));
    expect(onOpenMaster).toHaveBeenCalledTimes(1);
  });

  it('marks what to replace when changes are requested, and submits only once it is fixed', async () => {
    replies['GET /masters/me'] = { body: master('changes_requested') };
    replies['GET /masters/me/documents'] = {
      body: [
        doc('id_card_front', 'accepted'),
        doc('id_card_back', 'accepted'),
        doc('selfie_with_id', 'rejected'),
      ],
    };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.documentsChangesRequested)).toBeOnTheScreen();
    });
    expect(screen.getByText(copy.slotLabels.rejected)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: copy.submitAction })).toBeDisabled();
  });

  it('says there is nothing left to do for a verified master', async () => {
    replies['GET /masters/me'] = { body: master('active') };
    replies['GET /masters/me/documents'] = { body: [] };
    await mount();

    await waitFor(() => {
      expect(screen.getByText(copy.activeTitle)).toBeOnTheScreen();
    });
  });
});
