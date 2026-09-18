import type { Address } from '@tezusta/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Provider } from 'react-redux';

import { createAppStore, type AppStore } from '../store';
import { AddressForm, type AddressFormValues } from './AddressForm';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const SETTLED = { timeout: 10_000 };

interface GeocodeReply {
  readonly status: number;
  readonly body: unknown;
}

let geocodeReply: GeocodeReply = {
  status: 200,
  body: { status: 'ok', latitude: 40.4, longitude: 49.9, placeId: null },
};

function installTransport(): void {
  global.fetch = ((input: Request | string): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(input) : input;
    if (new URL(request.url).pathname !== '/geocode/forward') {
      return Promise.reject(new Error(`Unexpected request to ${request.url}`));
    }
    return Promise.resolve(
      new Response(JSON.stringify(geocodeReply.body), {
        status: geocodeReply.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

const INITIAL: Address = {
  id: 'addr-1',
  label: 'Ev',
  formattedAddress: 'Nizami küçəsi 203',
  building: '12B',
  entrance: '2',
  floor: null,
  apartment: null,
  landmarkNote: null,
  latitude: 40.377,
  longitude: 49.892,
  isDefault: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

async function mount(
  props: Partial<React.ComponentProps<typeof AddressForm>> = {},
): Promise<{ store: AppStore; onSubmit: jest.Mock; onCancel: jest.Mock }> {
  const store = createAppStore();
  const onSubmit = jest.fn();
  const onCancel = jest.fn();
  await render(
    <Provider store={store}>
      <AddressForm
        mode="add"
        submitting={false}
        onSubmit={onSubmit}
        onCancel={onCancel}
        {...props}
      />
    </Provider>,
  );
  return { store, onSubmit, onCancel };
}

describe('AddressForm', () => {
  beforeEach(() => {
    geocodeReply = {
      status: 200,
      body: { status: 'ok', latitude: 40.4, longitude: 49.9, placeId: null },
    };
    installTransport();
  });

  it('will not save an address that has never been found', async () => {
    await mount();

    expect(screen.getByRole('button', { name: 'Yadda saxla' })).toBeDisabled();
  });

  it('validates before submitting: typing alone does not enable Save, only a successful find does', async () => {
    const { onSubmit } = await mount();

    await fireEvent.changeText(screen.getByLabelText('Ünvan'), 'Nizami küçəsi 203');
    expect(screen.getByRole('button', { name: 'Yadda saxla' })).toBeDisabled();

    await fireEvent.press(screen.getByRole('button', { name: 'Ünvanı tap' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Yadda saxla' })).not.toBeDisabled();
    }, SETTLED);

    await fireEvent.press(screen.getByRole('button', { name: 'Yadda saxla' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining<Partial<AddressFormValues>>({
        formattedAddress: 'Nizami küçəsi 203',
        latitude: 40.4,
        longitude: 49.9,
      }),
    );
  });

  it('surfaces a no-result geocoding failure against the address field, without losing what was typed', async () => {
    geocodeReply = { status: 200, body: { status: 'no-result' } };
    await mount();

    await fireEvent.changeText(screen.getByLabelText('Ünvan'), 'Mövcud olmayan bir yer');
    await fireEvent.press(screen.getByRole('button', { name: 'Ünvanı tap' }));

    await waitFor(() => {
      expect(
        screen.getByText('Bu ünvan tapılmadı. Zəhmət olmasa yenidən yazın.'),
      ).toBeOnTheScreen();
    }, SETTLED);

    expect(screen.getByLabelText('Ünvan')).toHaveProp('value', 'Mövcud olmayan bir yer');
    expect(screen.getByRole('button', { name: 'Yadda saxla' })).toBeDisabled();
  });

  it('invalidates a coordinate once the address text moves away from what it was found for', async () => {
    await mount();

    await fireEvent.changeText(screen.getByLabelText('Ünvan'), 'Nizami küçəsi 203');
    await fireEvent.press(screen.getByRole('button', { name: 'Ünvanı tap' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Yadda saxla' })).not.toBeDisabled();
    }, SETTLED);

    await fireEvent.changeText(screen.getByLabelText('Ünvan'), 'Nizami küçəsi 203A');

    expect(screen.getByRole('button', { name: 'Yadda saxla' })).toBeDisabled();
  });

  it('prefills an edit form from the existing address and treats it as already found', async () => {
    await mount({ mode: 'edit', initial: INITIAL });

    expect(screen.getByLabelText('Ünvan')).toHaveProp('value', INITIAL.formattedAddress);
    expect(screen.getByLabelText('Ad (məs. Ev, İş)')).toHaveProp('value', 'Ev');
    expect(screen.getByLabelText('Bina')).toHaveProp('value', '12B');
    expect(screen.getByRole('button', { name: 'Yadda saxla' })).not.toBeDisabled();
  });

  it('surfaces a server field error against the field it names', async () => {
    await mount({
      error: {
        status: 422,
        data: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Validation failed.',
            requestId: 'req-1',
            details: { issues: [{ path: 'building', message: 'Çox uzundur.' }] },
          },
        },
      },
    });

    expect(screen.getByText('Çox uzundur.')).toBeOnTheScreen();
  });

  it('shows a banner, not a field error, for the too-many-addresses conflict', async () => {
    await mount({
      error: { status: 409, data: { error: { code: 'CONFLICT', message: 'x', requestId: 'r' } } },
    });

    expect(
      screen.getByText('Maksimum ünvan sayına çatmısınız. Yeni ünvan üçün birini silin.'),
    ).toBeOnTheScreen();
  });

  it('lets the customer cancel without submitting anything', async () => {
    const { onCancel, onSubmit } = await mount();

    await fireEvent.press(screen.getByRole('button', { name: 'İmtina et' }));

    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
