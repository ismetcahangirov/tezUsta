import type { OwnReport, ReportableParty } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { OrderReport } from './OrderReport';
import { REPORTS_COPY as copy } from './report-copy';
import { reportsApi } from './report-endpoints';
import { ReportEntry } from './ReportEntry';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const ORDER_ID = 'order-1';
const PARTIES_PATH = `/orders/${ORDER_ID}/reports/parties`;
const REPORTS_PATH = `/orders/${ORDER_ID}/reports`;
const MINE_PATH = `/orders/${ORDER_ID}/reports/mine`;

function party(overrides: Partial<ReportableParty> = {}): ReportableParty {
  return {
    role: 'master',
    profileId: 'master-1',
    displayName: 'Rəşad Usta',
    current: true,
    open: true,
    closesAt: null,
    report: null,
    ...overrides,
  };
}

function ownReport(overrides: Partial<OwnReport> = {}): OwnReport {
  return {
    id: 'report-1',
    orderId: ORDER_ID,
    reasonCode: 'no_show',
    text: 'Gəlmədi, zəngə də cavab vermədi.',
    status: 'open',
    editable: true,
    createdAt: '2026-10-10T10:00:00.000Z',
    updatedAt: '2026-10-10T10:00:00.000Z',
    ...overrides,
  };
}

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
}

let replies: Record<string, Reply> = {};
let sent: { method: string; path: string; body: unknown }[] = [];

function installTransport(): void {
  global.fetch = (async (input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.text();
    sent.push({
      method: request.method,
      path: url.pathname,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    });
    const reply = replies[`${request.method} ${url.pathname}`] ?? {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: '' } },
    };
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function writes(method: 'POST' | 'PUT'): unknown[] {
  return sent.filter((request) => request.method === method).map((request) => request.body);
}

async function mountForm(): Promise<{ onDone: jest.Mock }> {
  installTransport();
  const onDone = jest.fn();
  await render(
    <Provider store={createTestStore()}>
      <OrderReport orderId={ORDER_ID} onBack={jest.fn()} onDone={onDone} />
    </Provider>,
  );
  return { onDone };
}

beforeEach(() => {
  replies = {};
  sent = [];
});

/** The report form (#330, ADR-0053). */
describe('OrderReport', () => {
  it('asks for a reason before sending, then sends the reason and the words', async () => {
    replies[`GET ${PARTIES_PATH}`] = { body: [party()] };
    replies[`POST ${REPORTS_PATH}`] = { status: 201, body: ownReport() };
    const { onDone } = await mountForm();

    await fireEvent.press(await screen.findByText(copy.submit));
    expect(await screen.findByText(copy.reasonRequired)).toBeOnTheScreen();
    expect(writes('POST')).toEqual([]);

    await fireEvent.press(screen.getByText(copy.reason.no_show));
    await fireEvent.changeText(screen.getByLabelText(copy.textLabel), '  Gəlmədi.  ');
    await fireEvent.press(screen.getByText(copy.submit));

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
    // One master: nothing to choose, but the report still names the one shown.
    expect(writes('POST')).toEqual([
      { reasonCode: 'no_show', text: 'Gəlmədi.', masterId: 'master-1' },
    ]);
    expect(screen.queryByText(copy.whoLabel)).not.toBeOnTheScreen();
    expect(screen.getByText(copy.privacyNote)).toBeOnTheScreen();
  });

  it('lets the customer choose among the order’s masters, and names the one chosen', async () => {
    replies[`GET ${PARTIES_PATH}`] = {
      body: [
        party({ profileId: 'master-left', displayName: 'Gəlməyən Usta', current: false }),
        party({ profileId: 'master-now', displayName: 'Yeni Usta', current: true }),
      ],
    };
    replies[`POST ${REPORTS_PATH}`] = { status: 201, body: ownReport() };
    const { onDone } = await mountForm();

    expect(await screen.findByText(copy.whoLabel)).toBeOnTheScreen();
    expect(
      screen.getByLabelText(`Yeni Usta, ${copy.whoCurrent}, ${copy.selected}`),
    ).toBeOnTheScreen();

    await fireEvent.press(screen.getByText('Gəlməyən Usta'));
    await fireEvent.press(screen.getByText(copy.reason.no_show));
    await fireEvent.press(screen.getByText(copy.submit));

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
    expect(writes('POST')).toEqual([
      { reasonCode: 'no_show', text: null, masterId: 'master-left' },
    ]);
  });

  it('edits a report nobody has picked up yet', async () => {
    replies[`GET ${PARTIES_PATH}`] = { body: [party({ report: ownReport() })] };
    replies[`PUT ${MINE_PATH}`] = { body: ownReport({ reasonCode: 'damage' }) };
    const { onDone } = await mountForm();

    expect(await screen.findByText(copy.editableNotice)).toBeOnTheScreen();
    expect(screen.getByDisplayValue('Gəlmədi, zəngə də cavab vermədi.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByText(copy.reason.damage));
    await fireEvent.press(screen.getByText(copy.save));

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
    expect(writes('PUT')).toEqual([
      { reasonCode: 'damage', text: 'Gəlmədi, zəngə də cavab vermədi.', masterId: 'master-1' },
    ]);
  });

  it('shows a report being handled as read-only', async () => {
    replies[`GET ${PARTIES_PATH}`] = {
      body: [party({ report: ownReport({ status: 'in_review', editable: false }) })],
    };
    await mountForm();

    expect(await screen.findByText(copy.inReviewNotice)).toBeOnTheScreen();
    expect(screen.getByText('Gəlmədi, zəngə də cavab vermədi.')).toBeOnTheScreen();
    expect(screen.queryByText(copy.submit)).not.toBeOnTheScreen();
    expect(screen.queryByText(copy.save)).not.toBeOnTheScreen();
  });

  it('shows a report still editable but past its window as read-only', async () => {
    replies[`GET ${PARTIES_PATH}`] = {
      body: [party({ open: false, report: ownReport() })],
    };
    await mountForm();

    expect(await screen.findByText(copy.windowClosedNotice)).toBeOnTheScreen();
    expect(screen.queryByText(copy.save)).not.toBeOnTheScreen();
  });

  it('opens on the master already reported, not the blank one now on the order', async () => {
    replies[`GET ${PARTIES_PATH}`] = {
      body: [
        party({
          profileId: 'master-left',
          displayName: 'Gəlməyən Usta',
          current: false,
          report: ownReport(),
        }),
        party({ profileId: 'master-now', displayName: 'Yeni Usta', current: true }),
      ],
    };
    await mountForm();

    expect(await screen.findByText(copy.editableNotice)).toBeOnTheScreen();
    expect(
      screen.getByLabelText(`Gəlməyən Usta, ${copy.whoLeft}, ${copy.selected}`),
    ).toBeOnTheScreen();
  });

  it('says when nobody can be reported', async () => {
    replies[`GET ${PARTIES_PATH}`] = { body: [party({ open: false })] };
    await mountForm();
    expect(await screen.findByText(copy.unavailableTitle)).toBeOnTheScreen();
  });

  it('explains a closed window the server reports', async () => {
    replies[`GET ${PARTIES_PATH}`] = { body: [party()] };
    replies[`POST ${REPORTS_PATH}`] = {
      status: 409,
      body: { error: { code: 'REPORT_WINDOW_CLOSED', message: '' } },
    };
    await mountForm();

    await fireEvent.press(await screen.findByText(copy.reason.other));
    await fireEvent.press(screen.getByText(copy.submit));
    expect(await screen.findByText(copy.failure.closed)).toBeOnTheScreen();
  });
});

/** The entry on the order and job screens. */
describe('ReportEntry', () => {
  async function mountEntry(): Promise<{ onPress: jest.Mock; settled: () => boolean }> {
    installTransport();
    const onPress = jest.fn();
    const store = createTestStore();
    await render(
      <Provider store={store}>
        <ReportEntry orderId={ORDER_ID} onPress={onPress} />
      </Provider>,
    );
    const settled = (): boolean =>
      reportsApi.endpoints.reportParties.select(ORDER_ID)(store.getState()).isSuccess;
    return { onPress, settled };
  }

  it('offers a report while one is possible', async () => {
    replies[`GET ${PARTIES_PATH}`] = { body: [party()] };
    const { onPress } = await mountEntry();
    await fireEvent.press(await screen.findByText(copy.entry));
    expect(onPress).toHaveBeenCalledWith(ORDER_ID);
  });

  it('says a report was filed once there is one', async () => {
    replies[`GET ${PARTIES_PATH}`] = {
      body: [party({ open: false, report: ownReport({ status: 'closed', editable: false }) })],
    };
    await mountEntry();
    expect(await screen.findByText(copy.entryDone)).toBeOnTheScreen();
  });

  it('shows nothing when nobody can be reported and nothing was filed', async () => {
    replies[`GET ${PARTIES_PATH}`] = { body: [] };
    const { settled } = await mountEntry();
    // Settled, not merely sent: the answer has been read and rendered.
    await waitFor(() => {
      expect(settled()).toBe(true);
    });
    expect(screen.queryByText(copy.entry)).not.toBeOnTheScreen();
    expect(screen.queryByText(copy.entryDone)).not.toBeOnTheScreen();
  });
});
