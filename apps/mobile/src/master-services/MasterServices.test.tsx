import type { MasterService, Service, ServiceCategory } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createTestStore } from '../../test/support/test-store';
import { MASTER_SERVICES_COPY as copy } from './master-services-copy';
import { MasterServices } from './MasterServices';

/**
 * The master's services screen (ADR-0063), against a fake server that keeps
 * the master's list: what is asserted is what the master sees and what reached
 * the API.
 */

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const PLUMBING: ServiceCategory = {
  id: 'cat-1',
  slug: 'plumbing',
  name: 'Santexnika',
  displayOrder: 1,
};
const LOCKS: ServiceCategory = { id: 'cat-2', slug: 'locks', name: 'Qıfıllar', displayOrder: 2 };

function service(id: string, name: string, categoryId: string, fixed: boolean): Service {
  return {
    id,
    categoryId,
    slug: id,
    name,
    pricing: fixed ? { kind: 'fixed', amountMinor: 3000, currency: 'AZN' } : { kind: 'inspection' },
    displayOrder: 1,
  };
}

const TAP = service('svc-tap', 'Kran təmiri', PLUMBING.id, true);
const PIPE = service('svc-pipe', 'Boru sızması', PLUMBING.id, false);
const LOCK = service('svc-lock', 'Qıfıl açılması', LOCKS.id, true);

function offered(serviceId: string, priceMinor: number | null, isActive = true): MasterService {
  return {
    serviceId,
    priceMinor,
    isActive,
    createdAt: '2026-10-25T08:00:00.000Z',
    updatedAt: `2026-10-25T08:00:00.000Z#${String(priceMinor)}${String(isActive)}`,
  };
}

let mine: MasterService[] = [];
let failWrites = false;
let failList = false;
let calls: { method: string; path: string; body: unknown }[] = [];

function page<T>(items: T[]): Response {
  return Response.json({ items, nextCursor: null });
}

function installServer(): void {
  global.fetch = (async (input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    const url = new URL(request.url);
    const text =
      request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
    const body = text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>);
    calls.push({ method: request.method, path: url.pathname, body });

    if (url.pathname === '/services/categories') return page([PLUMBING, LOCKS]);
    if (url.pathname === '/services') return page([TAP, PIPE, LOCK]);

    if (url.pathname === '/masters/me/services' && request.method === 'GET') {
      // A 404, not a 500: the base query retries a 5xx with backoff.
      return failList ? Response.json({}, { status: 404 }) : Response.json(mine);
    }
    if (failWrites) {
      return Response.json({ code: 'CONFLICT', message: 'No.' }, { status: 409 });
    }
    if (url.pathname === '/masters/me/services' && request.method === 'POST') {
      const added = offered(
        body?.serviceId as string,
        (body?.priceMinor as number | undefined) ?? null,
      );
      mine = [...mine, added];
      return Response.json(added, { status: 201 });
    }
    const serviceId = url.pathname.split('/').pop() ?? '';
    if (request.method === 'DELETE') {
      mine = mine.filter((row) => row.serviceId !== serviceId);
      return new Response(null, { status: 204 });
    }
    if (request.method === 'PATCH') {
      mine = mine.map((row) =>
        row.serviceId === serviceId
          ? offered(
              serviceId,
              (body?.priceMinor as number | undefined) ?? row.priceMinor,
              (body?.isActive as boolean | undefined) ?? row.isActive,
            )
          : row,
      );
      return Response.json(mine.find((row) => row.serviceId === serviceId));
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
}

async function mount(): Promise<{ onBack: jest.Mock }> {
  const onBack = jest.fn();
  await render(
    <Provider store={createTestStore()}>
      <MasterServices onBack={onBack} />
    </Provider>,
  );
  return { onBack };
}

function writes(): { method: string; path: string; body: unknown }[] {
  return calls.filter((call) => call.method !== 'GET');
}

beforeEach(() => {
  mine = [];
  failWrites = false;
  failList = false;
  calls = [];
  installServer();
});

describe('the list', () => {
  it('shows each service with its price, and says which are paused', async () => {
    mine = [offered(TAP.id, 4550), offered(PIPE.id, null, false)];
    await mount();

    expect(await screen.findByText(TAP.name)).toBeOnTheScreen();
    expect(screen.getByText(/45,50/)).toBeOnTheScreen();
    expect(screen.getByText(PIPE.name)).toBeOnTheScreen();
    expect(screen.getByText(copy.priceAfterInspection)).toBeOnTheScreen();
    expect(screen.getByText(copy.paused)).toBeOnTheScreen();
  });

  it('starts empty with a way to add the first service', async () => {
    await mount();

    expect(await screen.findByText(copy.emptyTitle)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: copy.add })).toBeOnTheScreen();
  });

  it('offers a retry when the list cannot be read', async () => {
    failList = true;
    await mount();

    expect(await screen.findByText(copy.errorTitle)).toBeOnTheScreen();
    failList = false;
    await fireEvent.press(screen.getByRole('button', { name: copy.retry }));

    expect(await screen.findByText(copy.emptyTitle)).toBeOnTheScreen();
  });
});

describe('adding a service', () => {
  it('offers only the services not yet on the list, under their categories', async () => {
    mine = [offered(TAP.id, 4000)];
    await mount();

    await fireEvent.press(await screen.findByRole('button', { name: copy.add }));

    expect(screen.getByText(PLUMBING.name)).toBeOnTheScreen();
    expect(screen.getByText(LOCKS.name)).toBeOnTheScreen();
    expect(screen.getByText(PIPE.name)).toBeOnTheScreen();
    expect(screen.queryByText(TAP.name)).not.toBeOnTheScreen();
  });

  it('asks a fixed-price service for a valid price, then adds it', async () => {
    await mount();
    await fireEvent.press(await screen.findByRole('button', { name: copy.add }));
    await fireEvent.press(screen.getByText(LOCK.name));

    await fireEvent.press(screen.getByRole('button', { name: copy.confirmAdd }));
    expect(screen.getByText(copy.priceInvalid)).toBeOnTheScreen();
    expect(writes()).toEqual([]);

    await fireEvent.changeText(screen.getByLabelText(copy.priceLabel), '45,50');
    await fireEvent.press(screen.getByRole('button', { name: copy.confirmAdd }));

    expect(await screen.findByText(LOCK.name)).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: copy.title })).toBeOnTheScreen();
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: '/masters/me/services',
        body: { serviceId: LOCK.id, priceMinor: 4550 },
      },
    ]);
  });

  it('adds an inspection-priced service without a price', async () => {
    await mount();
    await fireEvent.press(await screen.findByRole('button', { name: copy.add }));
    await fireEvent.press(screen.getByText(PIPE.name));

    expect(screen.getByText(copy.inspectionHint)).toBeOnTheScreen();
    expect(screen.queryByLabelText(copy.priceLabel)).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: copy.confirmAdd }));

    await waitFor(() => {
      expect(writes()).toEqual([
        { method: 'POST', path: '/masters/me/services', body: { serviceId: PIPE.id } },
      ]);
    });
  });

  it('says so, and stays, when the server refuses', async () => {
    failWrites = true;
    await mount();
    await fireEvent.press(await screen.findByRole('button', { name: copy.add }));
    await fireEvent.press(screen.getByText(PIPE.name));
    await fireEvent.press(screen.getByRole('button', { name: copy.confirmAdd }));

    expect(await screen.findByText(copy.failed)).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: PIPE.name })).toBeOnTheScreen();
  });

  it('says when every catalogue service is already on the list', async () => {
    mine = [offered(TAP.id, 4000), offered(PIPE.id, null), offered(LOCK.id, 2000)];
    await mount();
    await fireEvent.press(await screen.findByRole('button', { name: copy.add }));

    expect(screen.getByText(copy.allAdded)).toBeOnTheScreen();
  });
});

describe('changing a service', () => {
  it('reprices it, starting from the price it has', async () => {
    mine = [offered(TAP.id, 4550)];
    await mount();
    await fireEvent.press(await screen.findByText(TAP.name));

    const field = screen.getByLabelText(copy.priceLabel);
    expect(field.props.value).toBe('45,50');
    await fireEvent.changeText(field, '60');
    await fireEvent.press(screen.getByRole('button', { name: copy.save }));

    expect(await screen.findByText(/60,00/)).toBeOnTheScreen();
    expect(writes()).toEqual([
      { method: 'PATCH', path: `/masters/me/services/${TAP.id}`, body: { priceMinor: 6000 } },
    ]);
  });

  it('pauses it and resumes it', async () => {
    mine = [offered(PIPE.id, null)];
    await mount();
    await fireEvent.press(await screen.findByText(PIPE.name));
    await fireEvent.press(screen.getByRole('button', { name: copy.pause }));

    expect(await screen.findByText(copy.paused)).toBeOnTheScreen();
    await fireEvent.press(screen.getByText(PIPE.name));
    await fireEvent.press(screen.getByRole('button', { name: copy.resume }));

    await waitFor(() => {
      expect(screen.queryByText(copy.paused)).not.toBeOnTheScreen();
    });
    expect(writes().map((call) => call.body)).toEqual([{ isActive: false }, { isActive: true }]);
  });

  it('removes it', async () => {
    mine = [offered(TAP.id, 4000)];
    await mount();
    await fireEvent.press(await screen.findByText(TAP.name));
    await fireEvent.press(screen.getByRole('button', { name: copy.remove }));

    expect(await screen.findByText(copy.emptyTitle)).toBeOnTheScreen();
    expect(writes()).toEqual([
      { method: 'DELETE', path: `/masters/me/services/${TAP.id}`, body: undefined },
    ]);
  });

  it('offers only removal for a service the catalogue has retired', async () => {
    mine = [offered('svc-retired', 1500)];
    await mount();
    await fireEvent.press(await screen.findByText(copy.retired));

    expect(screen.getByRole('button', { name: copy.remove })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: copy.pause })).not.toBeOnTheScreen();
    expect(screen.queryByLabelText(copy.priceLabel)).not.toBeOnTheScreen();
  });
});

describe('going back', () => {
  it('steps back through the screen before leaving it', async () => {
    const { onBack } = await mount();
    await fireEvent.press(await screen.findByRole('button', { name: copy.add }));
    await fireEvent.press(screen.getByText(LOCK.name));

    await fireEvent.press(screen.getByRole('button', { name: copy.back }));
    expect(screen.getByText(PIPE.name)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: copy.back }));
    expect(screen.getByText(copy.emptyTitle)).toBeOnTheScreen();
    expect(onBack).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: copy.back }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
